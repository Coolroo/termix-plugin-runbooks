/**
 * Raw output of bash 5.2.15 in a terminal, recorded with util-linux script
 * (BUG-021): TERM=xterm-256color, the command pasted as Send to terminal
 * pastes it (bracketed paste), then Enter. `before` is what the terminal
 * showed before the send; `after` the pieces from the send on, as they
 * arrived. Made by recordings/record.sh; the inputs are recordings/*.in.
 */

export interface Recording {
  /** The terminal's width. */
  cols: number;
  before: string[];
  after: string[];
}

export const PROMPT = "wyatt@homepi:~$ ";

export const BASH: Record<string, Recording> = {
  /** cat of a config file, short enough for one row. */
  plain: {
    cols: 60,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mcat site.conf\u001b[27m",
      "\b\b\b\b\b\b\b\b\b\b\b\b\bcat site.conf\r\n\u001b[?2004l\r",
      "# nginx site\r\n# listen on 443 only\r\nserver_name homepi;\r\nlisten 443 ssl;\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
  /** the person deletes "conf" and types "conf.bak" before Enter. */
  edited: {
    cols: 60,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mcat site.conf\u001b[27m",
      "\b \b\b \b\b \b\b \b",
      "conf.bak",
      "\r\n\u001b[?2004l\r",
      "cat: site.conf.bak: No such file or directory\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\r",
      "exit\r\n",
    ],
  },
  /** the step clears the screen. */
  clear: {
    cols: 60,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mclear && echo ready\u001b[27m",
      "\rwyatt@homepi:~$ clear && echo ready\r\n\u001b[?2004l\r",
      "\u001b[H\u001b[2J\u001b[3J",
      "ready\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\r",
      "exit\r\n",
    ],
  },
  /** a command of two lines. */
  multi: {
    cols: 60,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mecho one\u001b[27m\r\n\r\u001b[7mecho two\u001b[27m",
      "\u001b[Amepi:~$ echo one\r\n\recho two\r\n\u001b[?2004l\r",
      "one\r\ntwo\r\n",
      "\u001b[?2004h",
      "wyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\r",
      "exit\r\n",
    ],
  },
  /** output that pauses on "50% ", then a CR. */
  progress: {
    cols: 60,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mprintf 'download 50%% '; sleep 0.6; printf '\u001b[27m\u001b[7m\\\u001b[27m\r\u001b[7m\\rdownload 100%%\\n'; echo saved\u001b[27m",
      "\u001b[A\b\b\b\b\b\b\b\b\b\b\b\b\b\b\bprintf 'download 50%% '; sleep 0.6; printf '\\rdownload 100%%\\n'; echo saved\r\n\u001b[?2004l\rdownload 50% ",
      "\rdownload 100%\r\nsaved\r\n\u001b[?2004h",
      "wyatt@homepi:~$ ",
      "exit\r\n",
      "\u001b[?2004l\r",
      "exit\r\n",
    ],
  },
  /** the person types the next command while the step runs; cd changes the prompt. */
  ahead: {
    cols: 60,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mcd /etc && echo moved && sleep 0.6\u001b[27m",
      "\rwyatt@homepi:~$ cd /etc && echo moved && sleep 0.6\r\n\u001b[?2004l\r",
      "moved\r\n",
      "cat hostname\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "cat hostname\r\n\u001b[?2004l\r",
      "home-server\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\r",
      "exit\r\n",
    ],
  },
  /** a long command at 40 columns: bash moves the cursor up and draws it again on Enter. */
  long: {
    cols: 40,
    before: ["\u001b[?2004hwyatt@homepi:~$ "],
    after: [
      "\u001b[7mcat site.conf | grep -v \u001b[27m\u001b[7m'\u001b[27m\r\u001b[7m'^#' | sed -e 's/443/8443/' && echo the \u001b[27m\u001b[7mc\u001b[27m\r\u001b[7mconfig file was read in full\u001b[27m",
      "\u001b[A\u001b[A\b\b\b\b\b\b\b\b\b\b\b\bcat site.conf | grep -v '^#' | sed -e 's/443/8443/' && echo the config file was read in full\r\n\u001b[?2004l\r",
      "server_name homepi;\r\nlisten 8443 ssl;\r\n",
      "the config file was read in full\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
  /** a root prompt, "# ", and a config file with "# " lines. */
  root: {
    cols: 60,
    before: ["\u001b[?2004hroot@homepi:~# "],
    after: [
      "\u001b[7mcat site.conf\u001b[27m",
      "\b\b\b\b\b\b\b\b\b\b\b\b\bcat site.conf\r\n\u001b[?2004l\r",
      "# nginx site\r\n# listen on 443 only\r\nserver_name homepi;\r\nlisten 443 ssl;\r\n",
      "\u001b[?2004hroot@homepi:~# ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
  /** the same command run by hand just before the step. */
  earlier: {
    cols: 60,
    before: [
      "\u001b[?2004hwyatt@homepi:~$ ",
      "cat site.conf\r\n\u001b[?2004l\r",
      "# nginx site\r\n# listen on 443 only\r\nserver_name homepi;\r\nlisten 443 ssl;\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
    ],
    after: [
      "\u001b[7mcat site.conf\u001b[27m",
      "\b\b\b\b\b\b\b\b\b\b\b\b\bcat site.conf\r\n\u001b[?2004l\r",
      "# nginx site\r\n# listen on 443 only\r\nserver_name homepi;\r\nlisten 443 ssl;\r\n",
      "\u001b[?2004hwyatt@homepi:~$ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
  /** a prompt of two lines (bold top line, then "❯ "). */
  twoline: {
    cols: 60,
    before: ["\u001b[?2004h\u001b[1mwyatt@homepi\u001b[0m ~\r\n❯ "],
    after: [
      "\u001b[7mecho hi\u001b[27m",
      "\r❯ echo hi\r\n\u001b[?2004l\rhi\r\n",
      "\u001b[?2004h\u001b[1mwyatt@homepi\u001b[0m ~\r\n❯ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
};

/**
 * Raw output of bash 5.3.9 on home-server (BUG-024), recorded over ssh -tt
 * with TERM=xterm-256color, the same paste and Enter. On Enter, bash 5.3
 * draws a command of one row again by a CR and a move right past the
 * prompt (ESC[C for each column); a command that wraps, by a move up and
 * the whole prompt. The paste and Enter went over `ssh -tt` after `stty cols`;
 * the command is `echo rb1410-capture-ok; uname -s`.
 */
export const BASH53: Record<string, Recording> = {
  /** 80 columns: one row. */
  wide: {
    cols: 80,
    before: [
      "\u001b[?2004h\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ ",
    ],
    after: [
      "\u001b[7mecho rb1410-capture-ok; uname -s\u001b[27m",
      "\r\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[Cecho rb1410-capture-ok; uname -s\r\n\u001b[?2004l\rrb1410-capture-ok\r\n",
      "Linux\r\n",
      "\u001b[?2004h\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
  /** 54 columns: the prompt and the command fill the row exactly. */
  exact: {
    cols: 54,
    before: [
      "\u001b[?2004h\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ ",
    ],
    after: [
      "\u001b[7mecho rb1410-capture-ok; uname -s\u001b[27m",
      "\r\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[Cecho rb1410-capture-ok; uname -s\r\n\u001b[?2004l\rrb1410-capture-ok\r\n",
      "Linux\r\n",
      "\u001b[?2004h\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
  /** 40 columns: the command wraps. */
  wrapped: {
    cols: 40,
    before: [
      "\u001b[?2004h\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ ",
    ],
    after: [
      "\u001b[7mecho rb1410-capture\u001b[27m\u001b[7m-\u001b[27m\u001b[7mok; uname -s\u001b[27m",
      "\u001b[A\r\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ echo rb1410-capture-ok; uname -s\r\n\u001b[?2004l\rrb1410-capture-ok\r\n",
      "Linux\r\n",
      "\u001b[?2004h\u001b]0;paseo@home-server: ~\u0007\u001b[01;32mpaseo@home-server\u001b[00m:\u001b[01;34m~\u001b[00m$ ",
      "exit\r\n\u001b[?2004l\rexit\r\n",
    ],
  },
};
