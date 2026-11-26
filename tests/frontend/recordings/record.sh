#!/bin/bash
# Records the raw output of an interactive bash for the capture tests
# (BUG-021): ../bash-recordings.ts holds what this made with bash 5.2.15.
#
#   record.sh <name> <cols> < <name>.in     writes <name>.log and <name>.tm
#   PS1V='root@homepi:~# ' record.sh root 60 < plain.in
#   node to-json.mjs . plain:60 edited:60 ... > bash-5.2.json
#
# Each line of <name>.in is "<delay in seconds><TAB><printf format>": what
# the person's terminal sends to bash (a paste is \e[200~...\e[201~).
name=$1
cols=${2:-60}
dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir/home"
printf '# nginx site\n# listen on 443 only\nserver_name homepi;\nlisten 443 ssl;\n' >"$dir/home/site.conf"
printf 'stty cols %s rows 24\nPS1=%q\ncd %q\n' "$cols" "${PS1V:-wyatt@homepi:~\$ }" "$dir/home" >"$dir/rc.$$"
feed() {
  while IFS=$'\t' read -r delay format; do
    sleep "$delay"
    printf "$format"
  done
  sleep 0.4
}
feed | TERM=xterm-256color script -q -E always -O "$dir/$name.log" -T "$dir/$name.tm" \
  -c "bash --rcfile $dir/rc.$$ -i" >/dev/null 2>&1
rm -f "$dir/rc.$$"
