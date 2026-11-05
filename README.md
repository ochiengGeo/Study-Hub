# StudyHub

A personal study app for your phone (PWA): timetable with cancellations,
attendance and class alerts; deadlines; flashcards with spaced repetition;
a study-files library with a built-in PDF viewer; and quick notes.
Plain HTML/CSS/JS, no build step. All data stays on the device (IndexedDB),
so use **⋯ → Export backup** now and then.

## Layout
```
www/                 the app itself (HTML/CSS/JS). Edit things here.
  index.html style.css
  shared.js          database + file auto-sorting (page and service worker)
  native.js          Android-only features (alarms, share, open-with)
  app.js             core: state, Today, deadlines, cards, notes, themes, settings
  timetable.js       classes, cancellations, attendance, week grid, .ics export
  alerts.js          class reminders
  files.js           files library + PDF viewer
  sync.js            sync with the laptop hub
  aicards.js         AI flashcards panel (the cards are made on the laptop)
  exams.js           practice exams: set, sit, see marked results
  examdates.js       Exams & CATs section (dates, countdowns)
  reminders.js       deadline/exam reminders + notification set-up
  askai.js           Ask AI (photos/screenshots → Gemini)
  main.js            start-up
  sw.js manifest.json icons/ vendor/pdfjs/
android/             generated Android project (Capacitor 8)
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
Over Wi-Fi the phone uses plain http, so alerts, offline mode and sharing are off.
Everything else works. Use HTTPS hosting (below) for the full app on the phone.
Don't open `index.html` by double-clicking it. Run as a local file, the app loses
offline support, notifications and the PDF viewer.

## Put it on your phone (GitHub Pages — free, HTTPS)
Offline mode and "install" need HTTPS, so host it:
1. Create a GitHub repo (e.g. `studyhub`) and push these files to it.
2. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. Open `https://<username>.github.io/studyhub/` on your phone.
4. **Android (Chrome):** ⋮ menu → *Add to Home screen* / *Install app*.
   **iPhone (Safari):** Share → *Add to Home Screen*.

## Updating
After changing files, bump `CACHE` in `sw.js` (e.g. `studyhub-v2`) and push.
The phone picks up the new version on the next launch (sometimes the one after).

## Card formatting
`` `inline code` ``, ```` ```code blocks``` ````, `**bold**`.
Desktop review shortcuts: **Space** = show answer, **1–4** = Again/Hard/Good/Easy.

## About alerts
Alerts fire while StudyHub is open or running in the background. A web app
can't wake itself once it's fully closed, so for guaranteed reminders use
**⋯ → Add timetable to phone calendar**. That exports `timetable.ics` with a
reminder before every class, and the phone's calendar handles it from there.

## Getting files in
- **Notes → Files → Add files** (pick several at once), or **Board photo**.
  A board photo gets tagged with whatever class is on right now.
- After installing on Android: **Share → StudyHub** from WhatsApp/Files/Drive.
- Files are sorted using the file name (`CSC311_lec4.pdf` → CSC 311 · Lecture notes).
  You can fix anything in the file's ⋯ Details.

## Android app
```bash
./build-android.sh            # → dist/StudyHub.apk
./run.sh phone                # then open http://<laptop-ip>:8000/StudyHub.apk on the phone
```
On the phone: allow your browser to "install unknown apps" when asked, then install.
To update later, build again and install over the top: your data stays.
The phone's Back button steps back inside the app (closes what's open, leaves a deck/review/paper,
returns to Today); on Today it asks you to press Back again to exit.

The Android app keeps its own data, separate from the browser version.
Move it with ☰ → Settings & backup → Export, then Import in the app.

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
- Files (PDFs, photos) are copied across as well. Until a file's contents arrive it shows ⏳.
- `sync-data/` holds the hub's copy of everything: a free backup. Keep it.
  The pairing code is in `sync-data/pairing-code`; delete that file and restart to get a new one.
- The laptop's Wi-Fi address can change (it did during development: 192.168.1.19 → 192.168.114.42).
  If the phone can't reach it, check the address on the laptop and update it in the phone app.

## AI flashcards from your unit notes
The laptop makes flashcards for each unit with Google Gemini and they sync to the phone
like everything else (`cardgen.py`, run by `serve.py`).
- **Notes used:** synced files filed as **Lecture notes** or **Books** with a unit set
  (e.g. COMP 226). PDFs (scanned ones too), photos, text. Fix a file's type/unit in its ⋯ Details.
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

## Slides & Word files
Tap a .pptx/.ppt/.docx → **📖 View in StudyHub**: the laptop converts it to PDF (LibreOffice) and
it opens in the built-in viewer; the copy stays on the phone, so next time it opens offline.
Files filed as **Slides** are also used for AI flashcards and practice exams.

## Ask AI
☰ → **Ask AI**: snap a photo or pick a screenshot of the notes / question you're stuck on, add a
question, choose 💡 Hint me (guides without giving it away), 📖 Explain, 🧮 Solve or ✅ Check mine
(marks your working). Follow-up questions keep the context. In the PDF viewer, **✨ Ask** sends
the page you're on. Route: with a Gemini key in the phone's Settings → Ask AI it talks to Google
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
