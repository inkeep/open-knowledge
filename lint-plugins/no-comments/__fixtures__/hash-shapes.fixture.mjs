export const SHELL_SENTINEL = '# ok';

export const SHELL_MUST_NOT_FIRE = [
  {
    id: 'F02',
    label: 'a hash inside double quotes',
    source: 'echo "a#b"\n# ok\n',
  },
  {
    id: 'F03',
    label: 'a hash inside single quotes',
    source: "printf '\\n# Auto-added by bootstrap\\n'\n# ok\n",
  },
  {
    id: 'F04',
    label: 'a hash inside an ANSI-C quoted string',
    source: "note=$'\\n# Note: detected a git worktree'\n# ok\n",
  },
  {
    id: 'F05',
    label: 'an unquoted heredoc body',
    source: 'cat <<END\n# body\nEND\n# ok\n',
  },
  {
    id: 'F06',
    label: 'a quoted heredoc body',
    source: "cat <<'END'\n# body\nEND\n# ok\n",
  },
  {
    id: 'F07',
    label: 'a tab-stripped heredoc body',
    source: 'cat <<-END\n\t# body\n\tEND\n# ok\n',
  },
  {
    id: 'F08',
    label: 'two heredocs queued on one line',
    source: 'cat <<A <<B\n# not1\nA\n# not2\nB\n# ok\n',
  },
  {
    id: 'F09',
    label: 'a parameter length expansion',
    source: 'v=abc; echo "${#v} ${#arr[@]}"\n# ok\n',
  },
  {
    id: 'F10',
    label: 'the positional-count parameter',
    source: 'echo $#\n# ok\n',
  },
  {
    id: 'F11',
    label: 'a prefix-stripping parameter expansion',
    source: 'repo=a/b; echo "${repo##*/} ${repo#a}"\n# ok\n',
  },
  {
    id: 'F12',
    label: 'a hash mid-word',
    source: 'echo A#x https://example.com#frag\n# ok\n',
  },
  {
    id: 'F13',
    label: 'a backslash-escaped hash',
    source: 'echo \\#x\n# ok\n',
  },
  {
    id: 'F15',
    label: 'a line continuation that joins mid-word',
    source: 'echo A\\\n#x\n# ok\n',
  },
  {
    id: 'F20',
    label: 'a multi-line double-quoted string carrying a hash line',
    source: 'x="line1\n# not a comment\nline3"\n# ok\n',
  },
  {
    id: 'F21',
    label: 'a hash inside a case pattern',
    source: 'case "$f" in\n  *#*) echo hash ;;\nesac\n# ok\n',
  },
  {
    id: 'F23',
    label: 'a hash inside a regex word',
    source: 's="#tag"\nif [[ $s =~ ^#+ ]]; then echo m; fi\n# ok\n',
  },
  {
    id: 'F24',
    label: 'a hash used as a sed delimiter',
    source: "echo abc | sed 's#b#Z#'\n# ok\n",
  },
  {
    id: 'D5a',
    label: 'arithmetic base notation',
    source: 'n=8; echo "$((10#$n)) $((16#ff))"\n# ok\n',
  },
  {
    id: 'D5a2',
    label: 'a hash inside an arithmetic command, which is an operand and not a comment',
    source: 'x=1\n(( x = 3 + 16#ff ))\n# ok\n',
  },
  {
    id: 'HS1',
    label: 'a here-string, which is not a heredoc opener',
    source: 'while read -r l; do echo "$l"; done <<< "$ips"\n# ok\n',
  },
  {
    id: 'D5b',
    label: 'a quoted hash inside a process substitution',
    source: 'cat <(printf "a#b\\n")\n# ok\n',
  },
  {
    id: 'D5c',
    label: 'a hash mid-word inside an unquoted regex in a conditional',
    source: 'x=a#b\nif [[ $x =~ a#b ]]; then echo m; fi\n# ok\n',
  },
];

export const SHELL_MUST_FIRE = [
  {
    id: 'F01',
    label: 'the shebang on line one',
    source: '#!/usr/bin/env bash\necho hi\n',
    comments: [],
    structural: ['#!/usr/bin/env bash'],
  },
  {
    id: 'F01b',
    label: 'a hash on line two, which is an ordinary comment',
    source: '#!/usr/bin/env bash\n# real\necho hi\n',
    comments: ['# real'],
    structural: ['#!/usr/bin/env bash'],
  },
  {
    id: 'F14',
    label: 'a hash after a line continuation that ends a word',
    source: 'echo A \\\n#x\n',
    comments: ['#x'],
  },
  {
    id: 'F16',
    label: 'a word-initial hash inside a conditional expression',
    source: 'if [[ -n "$x" #why\n]]; then echo in; fi\n',
    comments: ['#why'],
  },
  {
    id: 'F17',
    label: 'a hash inside a command substitution',
    source: 'echo $(echo hi # inner\n)\n',
    comments: ['# inner'],
  },
  {
    id: 'F18',
    label: 'a hash inside a backtick substitution',
    source: 'echo `echo hi # inner\n`\n',
    comments: ['# inner'],
  },
  {
    id: 'F18b',
    label: 'a hash inside a backtick substitution that closes on the same line',
    source: 'echo `echo hi # inner` after\n',
    comments: ['# inner'],
  },
  {
    id: 'F18c',
    label: 'a comment after a backtick substitution that carries one of its own',
    source: 'echo `echo a # c1` # real\n',
    comments: ['# c1', '# real'],
  },
  {
    id: 'F18d',
    label: 'a hash inside a backtick substitution that runs past an escaped backtick',
    source: 'echo `echo hi # a \\` b` after\n',
    comments: ['# a \\` b'],
  },
  {
    id: 'F19',
    label: 'a hash right after a metacharacter',
    source: 'echo A;#a\necho B|#b\ncat\necho C &#c\nwait\n(#d\n:\n)\n',
    comments: ['#a', '#b', '#c', '#d'],
  },
  {
    id: 'D5b2',
    label: 'a word-initial hash inside a process substitution',
    source: 'cat <(echo hi # inner\n)\n',
    comments: ['# inner'],
  },
];

export const YAML_GENERALIZABILITY_FIXTURE = [
  '# top of file',
  'name: build   # trailing on a mapping value',
  'on:',
  '  push:',
  '    branches: [main]           # a flow sequence keeps its comment',
  'env:',
  '  URL: https://example.com/x#frag',
  '  QUOTED: "a # b"',
  "  LITERAL: 'c # d'",
  '  EMPTY: ""            # an empty scalar still takes a comment',
  'jobs:',
  '  lint:',
  '    steps:',
  '      - run: |',
  '          set -eu',
  '          # this is shell inside a block scalar, not a yaml comment',
  '          echo "done"',
  '      - run: >-',
  '          folded text # still block-scalar body',
  '          second line',
  "      - name: Smoke the candidate's DMG   # a comment after an apostrophe",
  '      - name: after the block scalar   # a comment again',
  '        with:',
  '          args: "--flag=1 #2"',
  '',
  '  # an indented whole-line comment',
  '  test:',
  '    needs: lint',
  '',
  '# end of file',
  '',
].join('\n');
