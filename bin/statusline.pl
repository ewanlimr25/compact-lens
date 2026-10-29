#!/usr/bin/env perl
# compact-lens-statusline: compact-lens wrote this file and puts its own version here at each start; to change it, copy it under another name in this folder, keeping this line.
# compact-lens's count for a status line of your own: ccstatusline's Custom Command widget, or Claude
# Code's statusLine command. It reads the status line's JSON on standard input, counts the compactions in
# the session's transcript (each row holding "subtype":"compact_boundary"; inside a quoted text the probe
# is escaped, so it never matches there), adds the pinned notes and a waiting edit as compact-lens last
# wrote them, and prints one line. The count is kept beside the script, in .statusline/, so each run reads
# only what the transcript gained since the last one. It reads the transcript and never writes it.
use strict;
use warnings;
use Fcntl qw(O_WRONLY O_CREAT O_EXCL);
use File::Basename qw(dirname);
use File::Spec;

# JSON::PP ships with perl, but a minimal install can leave it out: then the line stays empty, and stderr says why.
my $JSON = eval { require JSON::PP; JSON::PP->new } or do { print STDERR "compact-lens: perl's JSON::PP is missing\n"; exit 0 };

my $BOUNDARY = '"subtype":"compact_boundary"';
# A session id as Claude Code spells one; anything else is never part of a path.
my $SESSION_ID = qr/\A[0-9A-Za-z][0-9A-Za-z_-]{0,127}\z/;
# How many bytes of the transcript's start tell it from another file at the same path.
my $HEAD_BYTES = 64;
# The transcript is read this much at a time, so a row of any length never sits in memory whole.
my $BLOCK_BYTES = 1024 * 1024;
# The bytes of a row kept from one block to the next: a probe across the edge starts in them.
my $CARRY_BYTES = length($BOUNDARY) - 1;
my $STATE_DIR = File::Spec->catdir(dirname(File::Spec->rel2abs(__FILE__)), '.statusline');
# The kept count is the owner's alone, as its folder is.
my $KEPT_MODE = 0600;
my $STATE_MODE = 0700;
# A new file only, and never through a link planted at its name (where the system has O_NOFOLLOW).
my $NEW_FILE = O_WRONLY | O_CREAT | O_EXCL | (eval { Fcntl::O_NOFOLLOW() } // 0);

# The status line's JSON, or undef when there is none to read.
sub read_input {
    local $/;
    my $text = <STDIN>;
    return undef unless defined $text && $text ne '';
    my $data = eval { $JSON->decode($text) };
    return ref $data eq 'HASH' ? $data : undef;
}

# A small file's whole text, or undef.
sub slurp {
    my ($path) = @_;
    open(my $fh, '<:raw', $path) or return undef;
    local $/;
    my $text = <$fh>;
    close $fh;
    return $text;
}

# The transcript's first bytes, as hex: a file put in its place starts otherwise.
sub head_of {
    my ($fh) = @_;
    sysseek($fh, 0, 0) or return '';
    my $read = sysread($fh, my $head, $HEAD_BYTES);
    return defined $read ? unpack('H*', $head) : '';
}

# The kept count: inode, head, offset of the first byte not yet read, compactions before it.
sub read_kept {
    my ($path) = @_;
    my $text = defined $path ? slurp($path) : undef;
    return () unless defined $text && $text =~ /\A(\d+) ([0-9a-f]*) (\d+) (\d+)\n?\z/;
    return ($1, $2, $3, $4);
}

# A file made new at `path`, never one already there: a temporary file a killed run left is removed once.
sub open_new {
    my ($path) = @_;
    my $fh;
    return $fh if sysopen($fh, $path, $NEW_FILE, $KEPT_MODE);
    return undef unless $!{EEXIST} && unlink $path;
    return sysopen($fh, $path, $NEW_FILE, $KEPT_MODE) ? $fh : undef;
}

# Writes the kept count whole or not at all: a temporary file of its own, then a rename.
sub write_kept {
    my ($path, @fields) = @_;
    return unless defined $path;
    mkdir $STATE_DIR, $STATE_MODE unless -d $STATE_DIR;
    my $temporary = "$path.$$";
    my $fh = open_new($temporary) or return;
    my $is_written = (print {$fh} join(' ', @fields), "\n") && close $fh;
    unlink $temporary unless $is_written && rename $temporary, $path;
}

# Counts the boundary rows from `offset` on, a block at a time; complete lines only. Returns the offset
# after the last newline read and the count up to it.
sub count_from {
    my ($fh, $offset, $count) = @_;
    sysseek($fh, $offset, 0) or return ($offset, $count);
    my ($position, $tail, $has) = ($offset, '', 0);
    while (my $read = sysread($fh, my $block, $BLOCK_BYTES)) {
        # A probe begun in the last block that ends in this one starts in its tail: it is the current row's.
        $has = 1 if $tail ne '' && index($tail . substr($block, 0, $CARRY_BYTES), $BOUNDARY) >= 0;
        my ($start, $next) = (0, index($block, $BOUNDARY));
        while ((my $newline = index($block, "\n", $start)) >= 0) {
            $next = index($block, $BOUNDARY, $start) if $next >= 0 && $next < $start;
            $count += 1 if $has || ($next >= 0 && $next < $newline);
            ($has, $start) = (0, $newline + 1);
            $offset = $position + $start;
        }
        $next = index($block, $BOUNDARY, $start) if $next >= 0 && $next < $start;
        $has = 1 if $next >= 0;
        my $from = length($block) - $CARRY_BYTES;
        $tail = ($start == 0 ? $tail : '') . substr($block, $from > $start ? $from : $start);
        $tail = substr($tail, -$CARRY_BYTES) if length($tail) > $CARRY_BYTES;
        $position += $read;
    }
    return ($offset, $count);
}

# The compactions the transcript holds, read from where the kept count stopped.
sub count_compactions {
    my ($transcript, $kept_path) = @_;
    open(my $fh, '<:raw', $transcript) or return 0;
    my ($inode, $size) = (stat $fh)[1, 7];
    my $head = head_of($fh);
    my ($kept_inode, $kept_head, $offset, $count) = read_kept($kept_path);
    my $is_same = defined $offset && $kept_inode == $inode && $kept_head eq $head && $offset <= $size;
    ($offset, $count) = count_from($fh, $is_same ? ($offset, $count) : (0, 0));
    close $fh;
    write_kept($kept_path, $inode, $head, $offset, $count);
    return $count;
}

# The pinned notes and a waiting edit, as compact-lens last wrote them for the session.
sub mod_status {
    my ($status_path) = @_;
    my $text = defined $status_path ? slurp($status_path) : undef;
    my $data = defined $text ? eval { $JSON->decode($text) } : undef;
    return ref $data eq 'HASH' ? $data : {};
}

sub main {
    my $input = read_input();
    return unless defined $input && defined $input->{transcript_path} && !ref $input->{transcript_path};
    my $id = defined $input->{session_id} && !ref $input->{session_id} && $input->{session_id} =~ $SESSION_ID ? $input->{session_id} : undef;
    my $kept = defined $id ? File::Spec->catfile($STATE_DIR, "$id.count") : undef;
    my $count = -f $input->{transcript_path} ? count_compactions($input->{transcript_path}, $kept) : 0;
    my $mod = mod_status(defined $id ? File::Spec->catfile($STATE_DIR, "$id.json") : undef);
    my $pinned = defined $mod->{pinned} && $mod->{pinned} =~ /\A\d+\z/ ? $mod->{pinned} : 0;
    my $line = $count == 1 ? '1 compaction' : "$count compactions";
    $line .= " · $pinned pinned" if $pinned > 0;
    $line .= ' · /compact applies the edit' if $mod->{pending};
    print "$line\n";
}

eval { main(); 1 };
exit 0;
