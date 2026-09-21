#!/usr/bin/env python3
"""Upload and publish a new version to the Chrome Web Store without touching the dashboard UI.

One-time setup (only the consent step needs a human):
  1. https://console.cloud.google.com/ -> create/pick a project
  2. APIs & Services -> Library -> enable "Chrome Web Store API"
  3. APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Desktop app
  4. OAuth consent screen -> Audience -> add your own Google account under "Test users"
     (a Testing-mode app only lets approved testers through; otherwise consent fails with 403)
  5. Add http://127.0.0.1:8791 to the client's "Authorized redirect URIs"
  6. python3 ops/publish_store.py auth --id <CLIENT_ID> --secret <SECRET>
     Opens the consent page and catches the redirect locally. The refresh token lands in
     ~/.config/xrf/store_credentials.json (chmod 600) and is reused forever.

Then every release is:
  python3 ops/publish_store.py upload            # uploads dist/<current version>.zip as a draft
  python3 ops/publish_store.py publish           # submits it for review
  python3 ops/publish_store.py status
"""
import argparse, http.server, json, pathlib, subprocess, sys, threading, urllib.parse, webbrowser

ITEM_ID = "ncffadgnbgcfadoaiaglgkbacjepccff"
CRED = pathlib.Path.home() / ".config/xrf/store_credentials.json"
ROOT = pathlib.Path(__file__).resolve().parent.parent
LOOPBACK_PORT = 8791  # Google retired the out-of-band flow; desktop apps must use a loopback redirect
REDIRECT = f"http://127.0.0.1:{LOOPBACK_PORT}"
SCOPE = "https://www.googleapis.com/auth/chromewebstore"


def curl(args):
    out = subprocess.run(["curl", "-sS", "-m", "120", *args], capture_output=True, text=True)
    if out.returncode:
        sys.exit(f"curl failed: {out.stderr.strip()[:200]}")
    return out.stdout


def post_token(fields):
    body = urllib.parse.urlencode(fields)
    return json.loads(curl(["-d", body, "https://oauth2.googleapis.com/token"]))


def access_token():
    if not CRED.exists():
        sys.exit("No credentials yet. Run: python3 ops/publish_store.py auth --id ... --secret ...")
    c = json.loads(CRED.read_text())
    tok = post_token({"client_id": c["client_id"], "client_secret": c["client_secret"],
                      "refresh_token": c["refresh_token"], "grant_type": "refresh_token"})
    if "access_token" not in tok:
        sys.exit(f"token refresh failed: {tok}")
    return tok["access_token"]


def wait_for_code(timeout=300):
    """Serve 127.0.0.1 once, just long enough to catch Google's redirect and read the ?code= param."""
    box = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            box.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            ok = "code" in box
            self.wfile.write(("<h2>" + ("授权完成，可以关掉这个页面了。" if ok else "授权失败: " + box.get("error", "?")) + "</h2>").encode())

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", LOOPBACK_PORT), Handler)
    t = threading.Thread(target=srv.handle_request, daemon=True)
    t.start()
    t.join(timeout)
    srv.server_close()
    return box


def cmd_auth(args):
    url = "https://accounts.google.com/o/oauth2/auth?" + urllib.parse.urlencode(
        {"response_type": "code", "scope": SCOPE, "client_id": args.id, "redirect_uri": REDIRECT,
         "access_type": "offline", "prompt": "consent"})
    print("在浏览器里打开下面的链接并点「继续/允许」：\n", url, "\n等待授权回调...")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    box = wait_for_code()
    if "code" not in box:
        sys.exit(f"没有收到授权码: {box or '超时'}")
    tok = post_token({"client_id": args.id, "client_secret": args.secret, "code": box["code"],
                      "grant_type": "authorization_code", "redirect_uri": REDIRECT})
    if "refresh_token" not in tok:
        sys.exit(f"no refresh_token in response: {tok}")
    CRED.parent.mkdir(parents=True, exist_ok=True)
    CRED.write_text(json.dumps({"client_id": args.id, "client_secret": args.secret,
                                "refresh_token": tok["refresh_token"]}, indent=1))
    CRED.chmod(0o600)
    print("已保存到", CRED)


def current_zip():
    version = json.loads((ROOT / "manifest.json").read_text())["version"]
    z = ROOT / "dist" / f"x-reply-filter-{version}.zip"
    if not z.exists():
        sys.exit(f"{z} 不存在，先跑 ./build.sh")
    return version, z


def cmd_upload(_):
    version, zip_path = current_zip()
    out = json.loads(curl(["-X", "PUT", "-H", f"Authorization: Bearer {access_token()}",
                           "-H", "x-goog-api-version: 2", "-T", str(zip_path),
                           f"https://www.googleapis.com/upload/chromewebstore/v1.1/items/{ITEM_ID}"]))
    print(json.dumps(out, indent=1, ensure_ascii=False))
    if out.get("uploadState") != "SUCCESS":
        sys.exit(1)
    print(f"已上传 {version}，接着跑: python3 ops/publish_store.py publish")


def cmd_publish(_):
    out = json.loads(curl(["-X", "POST", "-H", f"Authorization: Bearer {access_token()}",
                           "-H", "x-goog-api-version: 2", "-H", "Content-Length: 0",
                           f"https://www.googleapis.com/chromewebstore/v1.1/items/{ITEM_ID}/publish"]))
    print(json.dumps(out, indent=1, ensure_ascii=False))


def cmd_status(_):
    out = curl(["-H", f"Authorization: Bearer {access_token()}", "-H", "x-goog-api-version: 2",
                f"https://www.googleapis.com/chromewebstore/v1.1/items/{ITEM_ID}?projection=DRAFT"])
    print(out)


p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = p.add_subparsers(dest="cmd", required=True)
a = sub.add_parser("auth"); a.add_argument("--id", required=True); a.add_argument("--secret", required=True); a.set_defaults(fn=cmd_auth)
sub.add_parser("upload").set_defaults(fn=cmd_upload)
sub.add_parser("publish").set_defaults(fn=cmd_publish)
sub.add_parser("status").set_defaults(fn=cmd_status)
args = p.parse_args()
args.fn(args)
