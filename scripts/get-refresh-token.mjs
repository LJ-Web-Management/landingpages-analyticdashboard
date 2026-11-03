// One-time helper: sign in to a Google account and print a credential entry
// for the GSC_ACCOUNTS secret. Run it once per Google account you want synced.
//
//   node scripts/get-refresh-token.mjs <client_id> <client_secret>
//
// Use an OAuth client of type "Desktop app" (Google Cloud → APIs & Services →
// Credentials). Run on your own computer: it opens a sign-in page in your
// browser and listens on 127.0.0.1 for Google's redirect.

import http from "node:http";
import { exec } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/get-refresh-token.mjs <client_id> <client_secret>");
  process.exit(1);
}

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "https://www.googleapis.com/auth/webmasters.readonly openid email",
    access_type: "offline", prompt: "consent select_account",
  });
  console.log("\nOpen this URL and sign in with the Google account to add:\n\n" + url + "\n");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${opener} "${url}"`, () => {});

  server.on("request", async (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    const code = params.get("code");
    if (!code) { res.end(params.get("error") || "Waiting for Google…"); return; }
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
      const tok = await tokenRes.json();
      if (!tok.refresh_token) throw new Error(tok.error_description || tok.error || "No refresh token returned.");
      let email = "";
      try { email = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url")).email || ""; } catch {}
      res.end("Done - you can close this tab and go back to the terminal.");
      console.log("Add this object to the GSC_ACCOUNTS JSON array (keep it secret):\n");
      console.log(JSON.stringify({ label: email, client_id: clientId, client_secret: clientSecret, refresh_token: tok.refresh_token }, null, 2));
    } catch (err) {
      res.end("Failed: " + err.message);
      console.error("Failed:", err.message);
      process.exitCode = 1;
    }
    server.close();
  });
});
