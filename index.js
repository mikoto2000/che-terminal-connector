const keypress = require('keypress');
const WebSocket = require('ws');

if(process.argv.length <= 2) {
  console.log("Usage: terminal-connector SERVER_URL");
  process.exit(0);
}

const serverUrl = process.argv[2]
const ws = new WebSocket(serverUrl);

ws.on('message', function incoming(data) {
  process.stdout.write(data);
});

process.on("exit", function() {
    process.exit(1);
});

ws.on('open', function open() {
  keypress(process.stdin);

  process.stdin.on('keypress', function (ch, key) {
    if (key && key.ctrl && key.name == 'c') {
      process.exit(1);
    }

    ws.send(ch);
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
});
