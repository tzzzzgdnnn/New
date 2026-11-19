#!/bin/sh
# CI only (build-ios.yml): puts the IPA and a one-tap SideInstaller page on
# gh-pages under get/$INSTALL_TOKEN/. The page is linked from nowhere, so
# only people you send the link to can find it.
#   sh scripts/publish-install-page.sh <path/to/App.ipa> <version>
set -e
IPA="$1"
VERSION="${2:-dev}"
: "${INSTALL_TOKEN:?INSTALL_TOKEN is not set}"
: "${GH_TOKEN:?GH_TOKEN is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

# GitHub refuses files over 100 MB.
SIZE=$(wc -c < "$IPA")
if [ "$SIZE" -gt 99000000 ]; then
  echo "IPA is $SIZE bytes, over GitHub's 100 MB file limit" >&2
  exit 1
fi
MB=$(awk "BEGIN { printf \"%.1f\", $SIZE / 1048576 }")

OWNER="${GITHUB_REPOSITORY%%/*}"
REPO="${GITHUB_REPOSITORY#*/}"
BASE="https://$(echo "$OWNER" | tr 'A-Z' 'a-z').github.io/$REPO/get/$INSTALL_TOKEN"
# A new file name per build so SideInstaller and Safari never reuse an old copy.
FILE="Super-Player-$VERSION.ipa"
IPA_URL="$BASE/$FILE"
ENC=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$IPA_URL")
STAMP=$(date -u +"%Y-%m-%d %H:%M UTC")

WORK=$(mktemp -d)
STAGE="$WORK/stage"
mkdir -p "$STAGE"
cp "$IPA" "$STAGE/$FILE"

cat > "$STAGE/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>Install Super Player</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: #0b0b0f; color: #f2f2f5;
         font: 16px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
         display: flex; justify-content: center; }
  main { width: 100%; max-width: 420px; padding: calc(env(safe-area-inset-top) + 48px) 24px 40px; text-align: center; }
  img { width: 96px; height: 96px; border-radius: 22px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  h1 { font-size: 26px; margin: 18px 0 4px; }
  .meta { color: #9a9aa6; font-size: 14px; margin: 0 0 28px; }
  a.btn { display: block; padding: 16px; border-radius: 14px; background: #e50914; color: #fff;
          font-weight: 600; font-size: 18px; text-decoration: none; }
  a.alt { display: inline-block; margin-top: 16px; color: #9a9aa6; font-size: 14px; }
  ol { text-align: left; color: #c9c9d1; font-size: 15px; padding-left: 20px; margin: 32px 0 0; }
  li { margin-bottom: 10px; }
</style>
</head>
<body>
<main>
  <img src="icon.png" alt="">
  <h1>Super Player</h1>
  <p class="meta">Version $VERSION &middot; $MB MB &middot; built $STAMP</p>
  <a class="btn" href="sideinstaller://install?url=$ENC">Install with SideInstaller</a>
  <a class="alt" href="$FILE" download>Download the IPA instead</a>
  <ol>
    <li>Open this page in Safari on the iPhone.</li>
    <li>Have SideInstaller set up, with LocalDevVPN connected.</li>
    <li>Tap Install, then confirm in SideInstaller. It signs the app with your Apple Account and installs it.</li>
    <li>To update, come back to this page and tap Install again.</li>
  </ol>
</main>
</body>
</html>
EOF

git clone -q --depth=1 --branch gh-pages \
  "https://x-access-token:$GH_TOKEN@github.com/$GITHUB_REPOSITORY.git" "$WORK/site"
cd "$WORK/site"
[ -f sp-icon.png ] && cp sp-icon.png "$STAGE/icon.png"

# gh-pages is also force-pushed by deploy-web.yml (which keeps get/): on a
# race, start again from the new gh-pages instead of rebasing onto it.
for i in 1 2 3; do
  rm -rf "get/$INSTALL_TOKEN" && mkdir -p "get/$INSTALL_TOKEN"
  cp -R "$STAGE/." "get/$INSTALL_TOKEN/"
  git add -A get
  git -c user.name=github-actions -c user.email=github-actions@users.noreply.github.com \
    commit -qm "Install page: Super Player $VERSION"
  if git push -q origin HEAD:gh-pages; then
    echo "Install page: $BASE/"
    exit 0
  fi
  git fetch -q --depth=1 origin gh-pages
  git reset -q --hard FETCH_HEAD
done
echo "Could not push the install page" >&2
exit 1
