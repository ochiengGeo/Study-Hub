# StudyHub

A study app for your phone: an Android app (also runs in a browser) with a timetable
(cancellations, attendance, class alerts), deadlines, Exams & CATs with countdowns, flashcards with
spaced repetition, a study-files library that opens PDFs, slides and Word files, and quick notes.
Gemini adds AI flashcards from your unit notes, practice exams that it marks, and Ask AI for photos
of what you're stuck on. Your laptop is the sync hub, and **Share nearby** sends files and decks
to friends' phones over Wi-Fi or a hotspot.

Plain HTML/CSS/JS, no build step; the Android app wraps the same files with Capacitor.
Data lives on each device (IndexedDB, plus a safe copy in the Android app's private folder) and
syncs through the laptop, which keeps daily backups. **☰ → Settings & backup → Export backup**
saves a JSON copy of everything except file contents.

## Layout
```
www/                 the app itself (HTML/CSS/JS). Edit things here.
  index.html style.css
  shared.js          database + file auto-sorting (page and service worker)
  native.js          Android-only features (alarms, share, open-with)
  vault.js           Android: file contents + a copy of every record in the app's private folder
  app.js             core: state, Today, deadlines, cards, notes, themes, settings
  timetable.js       classes, cancellations, attendance, week grid, .ics export
  alerts.js          class reminders
  files.js           files library + PDF viewer
  office.js          .pptx / .docx drawn on the phone (same viewer as PDFs)
  crop.js            pick part of a page/photo for Ask AI
  sync.js            sync with the laptop hub
  nearby.js          Share nearby: send files/decks to friends' phones over Wi-Fi/hotspot
  share-page.html    the download page a sharing phone shows friends without the app
  aicards.js         AI flashcards panel (cards made by the laptop, cardgen.py)
  nightcards.js      Android: nightly AI flashcards made by the phone itself
  runners/nightcards.js  the background job Android runs for that (about hourly)
  exams.js           practice exams: set, sit, see marked results
  examdates.js       Exams & CATs section (dates, countdowns)
  reminders.js       deadline/exam reminders + notification set-up
  askai.js           Ask AI (photos/screenshots → Gemini)
  main.js            start-up
  sw.js manifest.json icons/
  vendor/            pdfjs/ katex/ (maths) office/ (slides + Word) qr/ (Share nearby QR codes)
android/             Android project (Capacitor 8). Generated, plus our own code in
                     app/src/main/java/com/studyhub/app/ (Share nearby server) and AndroidManifest.xml
serve.py  run.sh     server + sync hub (keeps its copy in sync-data/)
cardgen.py           makes AI flashcards from unit notes with Gemini (used by serve.py)
exams.py             writes and marks practice exams with Gemini (used by serve.py)
backup.py            daily snapshots of sync-data/ to ~/StudyHub-backups
officeconv.py        slides / Word → PDF with LibreOffice
askai.py             Ask AI through the laptop
build-android.sh     builds dist/StudyHub.apk
```

## Run on your laptop
```bash
~/linux-lab/projects/studyhub/run.sh          # laptop only, opens the browser
~/linux-lab/projects/studyhub/run.sh phone    # also prints an address for your phone (same Wi-Fi)
```
Over Wi-Fi a phone *browser* uses plain http, so alerts, offline mode and "Share → StudyHub" are
off there. Everything else works. On the phone, use the Android app (below) for the full app.
Don't open `index.html` by double-clicking it. Run as a local file, the app loses
offline support, notifications and the PDF viewer.

## Browser version on your phone (GitHub Pages: free, HTTPS)
The Android app (below) is the main way to use StudyHub on a phone. For a browser-only install
(e.g. on an iPhone), offline mode and "install" need HTTPS, so host it:
1. Create a GitHub repo (e.g. `studyhub`) and push these files to it.
2. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. Open `https://<username>.github.io/studyhub/` on your phone.
4. **Android (Chrome):** ⋮ menu → *Add to Home screen* / *Install app*.
   **iPhone (Safari):** Share → *Add to Home Screen*.

## Updating
- **Android app:** `./build-android.sh`, then install the new `dist/StudyHub.apk` over the old one.
- **Browser version:** after changing files, bump `CACHE` in `sw.js` (now `studyhub-v25`) and push.
  Browsers pick up the new version on the next launch (sometimes the one after).
- The laptop server serves `www/` fresh on every request; restart `./run.sh` after changing the `.py` files.

## Card formatting
Cards (and AI answers) understand Markdown: `**bold**`, `*italic*`, `` `inline code` ``,
```` ```code blocks``` ````, headings, bullet/numbered lists, `> quotes` and `| tables |`, plus maths
in LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, drawn with KaTeX).
Desktop review shortcuts: **Space** = show answer, **1–4** = Again/Hard/Good/Easy.

## Getting files in
- **Notes → Files → Add files** (pick several at once), or **📷 Board photo**.
  A board photo gets tagged with whatever class is on right now.
- Android: **Share → StudyHub** from WhatsApp/Files/Drive.
- From a friend: **☰ → 📥 Receive from a friend** (see *Share nearby*).
- Files from your other devices come through sync (⬇ to download them here).
- Files are sorted using the file name (`CSC311_lec4.pdf` → CSC 311 · Lecture notes).
  You can fix anything in the file's ⋯ Details. ★ Star the important ones for exams.

## Android app
```bash
./build-android.sh            # → dist/StudyHub.apk
./run.sh phone                # then open http://<laptop-ip>:8000/StudyHub.apk on the phone
```
On the phone: allow your browser to "install unknown apps" when asked, then install.
To update later, build again and install over the top: your data stays.
Android / Play Protect warns that the app may be harmful. That's because it's a debug build signed
with this laptop's automatic "Android Debug" key, installed from outside the Play Store, not
because of anything the app does. Tap *More details → Install anyway*. Updates only install over
the top when they're built on this same laptop (the key is `~/.android/debug.keystore`).
The phone's Back button steps back inside the app (closes what's open, leaves a deck/review/paper,
returns to Today); on Today it asks you to press Back again to exit.

The Android app keeps its own data, separate from the browser version (sync both with the laptop,
or move it with ☰ → Settings & backup → Export, then Import in the app).
Android's WebView may delete an app's web data when the phone runs low on space, so the app also
keeps file contents and a copy of every record in its own private folder (`vault.js`). If the
database is ever found empty, it refills itself from that copy (you'll see "♻️ Restored …").

Toolchain (installed in your home folder, no sudo): Node in `~/.local/opt/node`,
Android SDK in `~/Android/Sdk`, JDK 21 from the system.

## Sync between phone and laptop
The laptop server is the hub; every device syncs with it.
1. On the laptop: `./run.sh phone`. It prints the **address** and a **pairing code**
   (also shown in the laptop's StudyHub under ☰ → Sync with laptop).
2. In the phone app: ☰ → **Sync with laptop**, enter address + code → **Connect & sync**.
3. After that it syncs by itself: when the app opens, a few seconds after any change,
   and every 3 minutes. Or tap ⟳ at the top. A green dot means the last sync worked.

- First sync merges both sides; nothing is lost. If the same item was edited on
  both devices, the most recent edit wins. Deletions sync too.
- Files: the list syncs straight away and each file's contents are uploaded to the laptop, but a
  device downloads a file only when you ask: tap ⬇ on it (or *Download all* on a unit) in Files.
  Until then it shows *Not downloaded*. ⋯ Details → *Remove download* frees the space on that device
  again (the laptop keeps its copy).
- `sync-data/` holds the hub's copy of everything: a free backup. Keep it.
  The pairing code is in `sync-data/pairing-code`; delete that file and restart to get a new one.
- The laptop's Wi-Fi address can change (it did during development: 192.168.1.19 → 192.168.114.42).
  If the phone can't reach it, check the address on the laptop and update it in the phone app.

## Share nearby (with friends, no laptop needed)
Send study files and flashcard decks straight from your phone to friends' phones over Wi-Fi.
- **Send:** ☰ → **📡 Share nearby** (or 📡 Nearby on a file, 📡 in a deck). Tick whole units, decks or
  single files → **Start sharing**. The phone shows a QR code, an address (e.g. `192.168.43.1:8765`)
  and a 4-digit PIN. Keep that screen open; it stays awake while friends download.
- **Receive:** ☰ → **📥 Receive from a friend** → 📷 Scan (or type the address + PIN), tick what you
  want, ⬇ Get. Files arrive sorted by unit and type; decks arrive as new cards on *your* schedule.
  Things you already have are left unticked. A dropped download carries on where it stopped.
- **No StudyHub?** Friends can scan the QR with their camera or open the address in any browser and
  download the files from a simple page (flashcards need the app; on Android it offers *Open in StudyHub*).
- **Network:** same Wi-Fi, or no router at all: turn on your hotspot and have friends join it.
  Some campus/guest Wi-Fi blocks phones from talking to each other; use the hotspot then.
- **Safety:** read-only (nobody can put anything on your phone), PIN required, locks after 20 wrong
  PINs, stops when you tap Stop or after 15 minutes with no downloads. Received items are your own
  copies; they sync to your laptop like anything else you add.
- Sending needs the Android app (a browser can't accept connections). Receiving works in the app
  and in the laptop browser (`./run.sh`). Code: `www/nearby.js`, `www/share-page.html`,
  `android/app/src/main/java/com/studyhub/app/ShareServer.java` + `NearbySharePlugin.java`.

## AI flashcards from your unit notes
The laptop makes flashcards for each unit with Google Gemini and they sync to the phone
like everything else (`cardgen.py`, run by `serve.py`).
- **Notes used:** synced files filed as **Lecture notes**, **Books** or **Slides** with a unit set
  (e.g. COMP 226). PDFs (scanned ones too), slides/Word (via LibreOffice), photos, text.
  Fix a file's type/unit in its ⋯ Details.
- **Weekly:** while `./run.sh` is running, each unit gets up to 12 new cards once a week from the
  *next* 25 pages of its notes (12 for scanned notes), so it works through them week by week and
  starts over when done. Small batches keep it inside Google's free limits.
- **Free limits:** every model has its own daily allowance. When one runs out it uses the next:
  other Gemini Flash versions, Flash-Lite, then Google's open-weights **Gemma** models.
- One deck per unit, e.g. `COMP 226 · Assembly Language Programming`. If the laptop was off,
  it catches up on start.
- **Now:** Flashcards → ✨ *AI cards from your notes* → ✨ More (or ✨ More inside a unit's deck).
- AI cards are marked 🤖. Delete bad ones with 🗑 *Bad card* while reviewing; they never come back.
- **API key:** free from aistudio.google.com → *Get API key*. `sync-data/gemini-key` holds either
  the key or the path of the file that does (now: `/home/george/confidKeys/apiKeys.txt`).
  It stays on the laptop, never in the app. No restart needed after changing it.
- A batch takes 1–6 minutes per unit (Gemini is sometimes busy; it retries by itself).
- Gemini's free tier may use what you send to improve Google's products.
- State and history: `sync-data/cardgen.json`. The model switches itself to the newest
  Gemini Flash if the current one is retired.

### Nightly cards on the phone (no laptop needed)
The Android app can make the weekly cards itself: Flashcards → **🌙 Nightly cards on this phone**.
- Needs a Gemini key on the phone (Settings → Ask AI) and the unit's notes downloaded on the phone.
- While you use the app it prepares each unit's next pages; at night (1–6 am by default, you can
  pick the window) Android's background job sends them to Gemini and posts a notification. The
  cards are added when you next open the app, and sync takes them to the laptop.
- A unit is skipped in a week it already got AI cards (from the laptop or the phone), so nothing doubles.
- The Flashcards tab shows when it last ran. "Never ran" usually means the phone's battery saving
  stops it: Settings → Apps → StudyHub → Battery → **Unrestricted**.
- **✨ Make this week's cards now** runs it straight away.

## Exams & CATs
☰ → **Exams & CATs**: add each CAT / main exam / practical with date, time, length, venue and
topics. Countdown, a 🃏 Revise button for the unit's flashcards and 📝 Practice paper. Today shows
the next one. Reminders: 3 days before (7 pm), the day before (7 pm) and 2 hours before. Exams
or CATs already in Deadlines can be moved over with one tap. Add your result afterwards.

## Notifications
On first start the app asks for notification permission and exact alarm timing, and explains the
battery setting some phones need (Tecno/Infinix/Xiaomi…: Settings → Apps → StudyHub → Battery →
Unrestricted). Class alerts, deadline reminders (1 day + 2 hours before) and exam reminders are all
handed to Android, so they arrive with the app closed. Today shows 🔕 if notifications are blocked.
Settings → Alerts & reminders has the switches and a test alert.
In a browser, alerts only fire while StudyHub is open. For reminders there, use
**☰ → 📅 Add timetable to phone calendar**: it exports `timetable.ics` with a reminder before every
class, and the phone's calendar handles it from there.

## Slides & Word files
- **.pptx / .docx** open right on the phone, in the same viewer as PDFs: offline, no laptop needed
  (`office.js`; it also draws the old Windows WMF/EMF pictures lecturers' diagrams often use).
- **Old .ppt / .doc**: tap **📖 View in StudyHub** and the laptop converts it to PDF (LibreOffice);
  the PDF copy stays on the phone, so next time it opens offline.
- Anything else: **↗ Open in another app** (WPS, Word, Google Docs…).
- Files filed as **Slides** are also used for AI flashcards and practice exams.

## Ask AI
☰ → **Ask AI**: snap a photo or pick a screenshot of the notes / question you're stuck on, add a
question, choose 💡 Hint me (guides without giving it away), 📖 Explain, 🧮 Solve or ✅ Check mine
(marks your working). Follow-up questions keep the context. In the PDF viewer, **✨ Ask** sends
the page you're on, and on photos you can drag a box to ask about just one part. Route: with a Gemini key in the phone's Settings → Ask AI it talks to Google
directly (works anywhere with internet); without one it goes through the laptop. The phone's key
is kept only on the phone (not synced, not in backups).

## Practice exams
Flashcards → 📝 **Practice exams**. Pick a unit (or one notes file) and a length:
**Quick** (5 questions, 15 min), **CAT** (10, 45 min) or **Full exam** (15, 2 h).
- Gemini sets the paper from pages sampled across the unit's notes. File past papers for the
  unit as **Past papers** and the questions copy their style and difficulty.
- Multiple choice, short answers, and structured questions with parts (a), (b)… and marks.
- Type answers, or add a 📷 photo of handwritten working (good for maths). Answers are saved on
  the phone as you go, so you can leave and come back; there's a timer, but no time limit.
- Submit → multiple choice is marked at once; written answers are marked by Gemini against a
  marking scheme (method marks, half marks), with feedback and what you missed. Grades: A ≥ 70%,
  B ≥ 60, C ≥ 50, D ≥ 40, else E.
- **🃏 Turn weak questions into flashcards** adds every question you scored under 60% on.
- Model answers stay hidden on the laptop until the paper is marked.
- Needs the laptop running (same Wi-Fi or Tailscale). Papers live in `sync-data/exams/`.

## Themes & settings
- **☰ → 🎨 Theme:** Auto (follows the phone), Light, Dark, Black (OLED) or Sepia, plus an accent
  colour, with a live preview.
- **☰ → ⚙️ Settings & backup:** class alert defaults and a test alert, notification set-up, the
  phone's Gemini key (Ask AI), storage used, **Export / Import backup** (JSON; file contents aren't
  included) and *Delete all data*.

## Backups
`serve.py` saves a snapshot of `sync-data/` when it starts and every day it runs, to
**`~/StudyHub-backups/<date>/`**. Kept: daily for a week, weekly for 8 weeks, monthly for a year.
Files are hard-linked, so a snapshot takes almost no extra space. The API key isn't included.
```bash
python3 backup.py                       # list snapshots
python3 backup.py now                   # take one now
python3 backup.py restore 2026-11-04_0900   # stop ./run.sh first; current data is set aside, not deleted
```
These are on the same disk: now and then copy `~/StudyHub-backups/` to a USB stick or cloud drive.
After a restore, devices still send whatever they changed since, on top of it.

### Syncing from anywhere (not just the same Wi-Fi)
Install **Tailscale** (free) on the laptop and phone and sign in to both with the same account.
They get private addresses (100.x.y.z) that work across any network.
Use the laptop's Tailscale address in the phone's Sync screen. Nothing is exposed to the internet.
