# Facebook and Instagram publishing

VidPush keeps Facebook and Instagram credentials and destinations independent.
Google sign-in identifies the VidPush owner; it does not select a publishing
account. This version supports one selected Facebook Page and one Instagram
professional account at a time. Reconnect to switch Instagram accounts; use the
Page selector to switch Facebook Pages.

Account names, IDs, credential references, callbacks, and setup status are tracked
under `publishing` in [accounts.yaml](accounts.yaml). Update that inventory when
each account is configured.

## Facebook

Create or select a Meta developer app with Facebook Login and the permissions
`pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`. Register the
exact Facebook callback in `accounts.yaml`. The authorizing Facebook user must have content creation
access to the Page. Configure `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, and
`FACEBOOK_REDIRECT_URI` in local `.env` and/or the Modal Secret.

Sign in to VidPush, click Facebook **Connect**, authorize the desired Pages, and
explicitly choose a Page from the selector. VidPush never silently selects the
first Page. Personal Facebook profiles are not publishing destinations.

Facebook Connect supports authorization in a different browser. Keep the original
VidPush tab open and use **Copy authorization link** to open the ten-minute link
in the browser signed into Facebook. That browser shows only a completion page;
it does not receive a VidPush session. The original tab polls for the result,
then prompts for an explicit Page selection. Only the initiating authenticated
session can claim the result. Starting another connection invalidates its old
link. Restarting the server or refreshing the initiating tab requires starting
a new connection. Do not share the authorization link with other people.

## Instagram

Configure **Instagram API with Instagram Login** in the Meta developer dashboard.
Use the Instagram App ID and secret shown in that product's setup; these are
separate configuration entries from the Facebook app credentials. Register the
Instagram callback in `accounts.yaml`. Request only `instagram_business_basic` and
`instagram_business_content_publish`.

Configure `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and
`INSTAGRAM_REDIRECT_URI`. Convert the publishing Instagram account to Business
or Creator if necessary. Click its own **Connect** button in VidPush and sign
into that account. This direct Instagram login does not require it to be linked
to the Facebook Page used by VidPush.

For development testing, configure the relevant app roles/test accounts and
accept invitations. Wider use may require Meta App Review and the access level
required for the selected permissions. Follow the current dashboard requirements.

## Upload behavior

- Facebook and Instagram publish **Reels**. Selecting a destination and pressing
  Upload publishes to the named account; these uploads are not private drafts.
- New Meta destinations default off. The UI shows the selected accounts, status,
  and separate success/error results for all four platforms.
- Title becomes the Reel caption/description. Instagram captions are limited to
  2,200 characters. VidPush accepts MP4/MOV up to 1 GB for Meta destinations;
  providers also enforce duration, codecs, aspect ratio, and other requirements.
  No automatic transcoding is performed.
- The server streams the file directly to Meta's upload endpoint. It does not
  expose uploaded files through a public URL. Instagram waits for container
  processing before publishing; Facebook waits for publication confirmation.
- Errors do not stop other selected platforms. Before retrying a failed or
  timed-out operation, check the account and deselect already successful
  destinations to avoid duplicates. Publishing is never automatically retried.
- Instagram long-lived tokens are refreshed during use when less than seven
  days remain. Expired/revoked credentials require reconnection. Facebook's
  stored Page connection conservatively uses the long-lived user-token expiry.
- `META_API_VERSION` defaults to `v24.0`. Check compatibility in your Meta app
  dashboard when selecting or updating an API version.

## Verification still required with real accounts

Account creation, Meta app credentials, callback registration, role/permission
approval, real OAuth connections, and a user-approved test publication are not
completed by the local implementation or mocked tests. Set up the accounts and
credentials before deployment and end-to-end testing.

## Official references

- [Instagram direct login and account requirements](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Meta's Reels publishing samples](https://github.com/fbsamples/reels_publishing_apis)
- [Facebook Reels publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing/)
- [Instagram publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/)
