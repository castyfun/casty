# The stage for docs/demo/casty.tape, sourced before the recording starts: a fresh home, the test
# fakes in front of PATH (the fake ssh runs the "host" commands in /tmp/host), and the mock
# Snapchain node on the port the tunnel would give. It expects the repository at /opt/casty with
# pnpm install run, on a Linux machine with vhs, ttyd, git, jq and Node 22.
export HOME=/home/you LANG=C.UTF-8
cd "$HOME" || exit
export PATH=/opt/casty/test/fakebin:/usr/local/bin:/usr/bin:/bin
export FAKE_LOG=/tmp/fake.log FAKE_REMOTE_HOME=/tmp/host
rm -rf "$FAKE_REMOTE_HOME" "$HOME/casty" "$HOME/.config" "$HOME/.cache" "$HOME/.ssh"
mkdir -p "$FAKE_REMOTE_HOME" "$HOME/.ssh"
cp /opt/casty/scripts/tests/fixtures/id_ed25519.pub "$HOME/.ssh/" && touch "$HOME/.ssh/id_ed25519"
export PREFLIGHT_MEM_KB=16777216 PREFLIGHT_FREE_KB=2147483648 POLL_MIN=1 POLL_MAX=1
export CASTY_PASSPHRASE=demo
pkill -f mock-snapchain >/dev/null 2>&1
node /opt/casty/test/mock-node/bin/mock-snapchain.mjs serve --port 3381 >/tmp/mock.log 2>&1 &
sleep 1.5
curl -fsS -X POST http://127.0.0.1:3381/__mock/control -d '{"blockDelay":[93600,4]}' >/dev/null
export PS1='\[\e[38;5;208m\]$\[\e[0m\] '
