/* Morning Deck for Friends: owner configuration (public values only, safe to commit).
 * Leave an ID empty and that sign-in shows "needs setup by the app owner"; everything else keeps working.
 * Step-by-step for filling these in: docs/FRIENDS-OWNER-SETUP.md */
window.MD_FRIENDS_CONFIG = Object.assign({
  // Google Cloud OAuth 2.0 Client ID (type "Web application"), e.g. "1234567890-abc123.apps.googleusercontent.com"
  googleClientId: '',
  // Microsoft Entra app (client) ID, a GUID, registered as a Single-page application (SPA)
  microsoftClientId: '',
  // Optional: shown on the feedback card as "Send feedback to …". Leave empty to say "the person who shared this app".
  ownerName: '',
  // Optional: a public feedback address. Leave empty and feedback goes through the phone's Share sheet instead.
  feedbackEmail: '',
  // News feeds that block browsers are fetched through this free relay (disclosed in the app; friends can switch it off).
  rssRelay: 'https://api.rss2json.com/v1/api.json?rss_url=',
  // Universal inbox relay (ntfy). Friends can point it at their own ntfy server in Settings.
  ntfyServer: 'https://ntfy.sh',
}, window.MD_FRIENDS_CONFIG || {});
