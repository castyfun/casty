# casty from an empty machine to a cast, recorded against the mock Snapchain node and stand-ins
# for the server (the test fakes in test/fakebin), so it runs anywhere in a minute.
Output casty-demo.gif

Require git
Set Shell "bash"
Set FontFamily "DejaVu Sans Mono"
Set FontSize 17
Set Width 1280
Set Height 760
Set Padding 26
Set LineHeight 1.25
Set TypingSpeed 32ms
Set WaitPattern /\$ *$/
Set WindowBar Colorful
Set BorderRadius 10
Set Margin 18
Set MarginFill "#1b1b19"
Set Theme { "name": "casty", "black": "#1b1b19", "red": "#ff7b7b", "green": "#72cf76", "yellow": "#e3a94b", "blue": "#7fb4ff", "magenta": "#ff7a45", "cyan": "#7fd1c7", "white": "#ecebe5", "brightBlack": "#96948c", "brightRed": "#ff9b9b", "brightGreen": "#8fe093", "brightYellow": "#f0c070", "brightBlue": "#a3c8ff", "brightMagenta": "#ff9c6e", "brightCyan": "#a0e4dc", "brightWhite": "#ffffff", "background": "#121211", "foreground": "#ecebe5", "selection": "#2b2a27", "cursor": "#ff7a45" }

Hide
Type "source /opt/casty/docs/demo/stage.sh && clear"
Enter
Sleep 2.5s
Show

Sleep 600ms
Type "git clone https://github.com/castyfun/casty.git && cd casty"
Sleep 300ms
Enter
Wait@90s
Sleep 800ms

Type "./scripts/0-provision.sh --host you@203.0.113.10   # (0) compute"
Sleep 400ms
Enter
Wait@90s
Sleep 2.5s

Type "./scripts/1-node.sh                               # (1) a read node"
Sleep 400ms
Enter
Wait@180s
Sleep 3s

Hide
Type "clear"
Enter
Sleep 300ms
Show

Type "./scripts/2-client.sh                             # (2) a client"
Sleep 400ms
Enter
Sleep 2s
# The download of the release takes a while; the recording skips it.
Hide
Wait+Line@5m /input hidden/
Show
Sleep 2.5s
# The prompt echoes nothing; this is the BIP-39 test phrase.
Type@25ms "test test test test test test test test test test test junk"
Sleep 300ms
Enter
Wait@180s
Sleep 4s

Hide
Type "clear"
Enter
Sleep 300ms
Show

Type "./bin/casty feed --limit 3"
Sleep 300ms
Enter
Wait@30s
Sleep 3s
Type './bin/casty cast "hello from my own node"'
Sleep 300ms
Enter
Wait@30s
Sleep 2.5s
Type "./bin/casty like 2"
Sleep 300ms
Enter
Wait@30s
Sleep 4s
