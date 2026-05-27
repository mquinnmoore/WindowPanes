# noVNC Remote Desktop Pane

Turn any pane into a live remote desktop view using noVNC and macOS Screen Sharing. No third-party relay required — everything runs on your local LAN.

## Architecture

```
[WindowPanes machine — Lubuntu]          [Target Mac Mini]
  Firefox kiosk (port 3000)
    └── iframe
          └── noVNC web client
                └── websockify (port 6080)  ──LAN──►  VNC server (port 5900)
```

The browser talks to a local WebSocket proxy (`websockify`) which bridges to the Mac Mini's built-in VNC server. No traffic leaves the LAN.

## Prerequisites

Both machines must be on the same local network.

## Step 1 — Enable Screen Sharing on the Mac Mini

1. Open **System Settings → General → Sharing**
2. Turn on **Screen Sharing**
3. Click the ⓘ button next to Screen Sharing
4. Enable **"Anyone may request permission to control screen"** or set a VNC password:
   - Under "Allow access for", choose **"Only these users"** or click **"Computer Settings…**
   - Check **"VNC viewers may control screen with password"** and set a password
5. Note the Mac Mini's local IP address (shown in the Screen Sharing dialog, or check **System Settings → Wi-Fi/Ethernet → Details**)

The VNC server listens on **port 5900** by default.

## Step 2 — Install noVNC and websockify on the Lubuntu machine

```bash
sudo apt update
sudo apt install novnc websockify
```

Verify:
```bash
which websockify       # should print /usr/bin/websockify
ls /usr/share/novnc/   # should contain vnc.html and core/
```

## Step 3 — Test the connection manually

Replace `192.168.1.X` with your Mac Mini's actual local IP:

```bash
websockify --web /usr/share/novnc 6080 192.168.1.X:5900
```

Then open a browser on the Lubuntu machine and go to:

```
http://localhost:6080/vnc.html?host=localhost&port=6080&autoconnect=true&resize=scale
```

You should see the Mac Mini's desktop. Enter the VNC password when prompted. If it connects cleanly, proceed to the next step.

## Step 4 — Install the systemd service for auto-start

```bash
# Copy the service file
sudo cp systemd/websockify-novnc.service /etc/systemd/system/

# Edit the file and set VNC_TARGET to your Mac Mini's IP
sudo nano /etc/systemd/system/websockify-novnc.service
# Change: Environment="VNC_TARGET=192.168.1.X:5900"

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable websockify-novnc
sudo systemctl start websockify-novnc

# Verify
sudo systemctl status websockify-novnc
```

## Step 5 — Add the pane to config.yaml

Edit `config.yaml` and add a pane of type `novnc`. Example (3-row kitchen layout, replacing row 1):

```yaml
  - type: novnc
    position: {row: 1, col: 1}
    novnc_url: "http://localhost:6080/vnc.html?host=localhost&port=6080&autoconnect=true&resize=scale&password=YOURPASSWORD"
```

Replace `YOURPASSWORD` with the VNC password you set in Step 1.

The `resize=scale` parameter makes the remote desktop scale to fit the pane size automatically — important for portrait/landscape layout differences.

## Troubleshooting

**Connection refused on port 6080**
- Check websockify is running: `sudo systemctl status websockify-novnc`
- Make sure no firewall is blocking localhost:6080

**"Disconnected" or timeout in noVNC**
- Verify the Mac Mini IP is correct in the service file
- Test ping: `ping 192.168.1.X`
- Make sure Screen Sharing is still enabled on the Mac Mini
- Check port 5900 is reachable: `nc -zv 192.168.1.X 5900`

**Black screen / no content**
- The Mac Mini may be sleeping. Check its Energy Saver settings and disable sleep or set a long timeout.
- Try waking it: `caffeinate -u -t 1` on the Mac Mini to prevent future sleep.

**Wrong password**
- The VNC password is separate from the macOS login password. Reset it in System Settings → Sharing → Screen Sharing → Computer Settings.

## Security Note

The VNC password is embedded in the noVNC URL in config.yaml. This is acceptable for a local kiosk display, but don't expose `config.yaml` or the websockify port to untrusted networks. The service binds to `localhost:6080` by default — do not change this to `0.0.0.0` unless you understand the implications.
