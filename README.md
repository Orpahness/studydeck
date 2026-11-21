# StudyDeck

A study dashboard that runs on phones, tablets and laptops:

- **Notes** — upload PDF / Word / PowerPoint / text files or write in the editor. Notes auto-save as you type, get an automatic title and tags, and are filed into a subject (Biology, History, …) automatically. Edit, pin, search, download as Markdown.
- **Library** — keep PDF books and handouts. Read the extracted text page by page, open the original, and generate study material from the whole file or a page range (e.g. pages 10–25).
- **Flashcards** — generated from notes/PDFs or written by hand. Spaced-repetition review (Again / Hard / Good / Easy) brings each card back right before you'd forget it.
- **Quizzes & exams** — multiple choice, true/false, fill-in-the-blank and short answer. Quizzes give instant feedback; exams are timed and graded at the end. Review mistakes, practise only the missed questions, edit or delete generated questions.
- **Studying a subject** — pick the subject you're studying on the dashboard (or add a new one). New uploads, notes, decks and quizzes go into it, and lists filter to it. Choose *All subjects* to let StudyDeck sort uploads automatically.
- **Uses your file's own questions** — if an uploaded PDF/Word file is already a quiz, reviewer or question bank (numbered questions, a/b/c/d choices, "Answer:" lines or an answer key at the end), StudyDeck imports those exact questions and answers instead of inventing new ones. Questions without an answer in the file can be completed in *Review & edit questions*.
- **Learn mode** — retention-first, in batches of 5 or 10. Inside a batch every item comes back until you've got it right twice (missed ones return sooner). After each batch, items from earlier batches come back for a retention check — even ones you got right — and anything forgotten is re-learned. A final retention check covers everything. No item limit. Results feed the spaced-repetition schedule.
- **Subjects** — rename, recolour or delete subjects from the dashboard (Edit chip), Notes, Flashcards, Quizzes or Settings. Deleting asks whether to keep or delete what's inside.
- **Up to 200 items** per generated deck/quiz/exam and per study session.
- **Write & export** — a writing card on the dashboard (and an export option on every note) downloads your notes as **PDF** or **Word (.docx)**, with headings, bullets, numbered lists, bold and italic.
- **Progress** — streak, daily activity, recall rate, mastery per deck, quiz score trend.
- **Privacy** — every row is locked to its owner with Postgres Row Level Security; uploaded files sit in a private bucket under the user's own folder. Deletes are hard deletes; *Reset all data* and *Delete account* wipe everything permanently. People can also use the app **without an account** (data stays in that browser only).

## How it's built

Plain HTML/CSS/JavaScript modules — **no build step**. Vercel serves the folder as a static site.

| Piece | Where |
|---|---|
| App shell, router, sign-in | `index.html`, `js/app.js` |
| Data layer (Supabase **or** in-browser IndexedDB) | `js/store.js` |
| File → text (PDF via pdf.js, DOCX/PPTX via a tiny zip reader) | `js/extract.js`, `vendor/` |
| Offline flashcard / question generator | `js/generator.js` |
| Import existing questions from a file | `js/importq.js` |
| Spaced repetition | `js/srs.js` |
| Learn mode (retention rounds) | `js/views/learn.js` |
| PDF / Word export | `js/export.js`, `vendor/pdf-lib/` |
| Screens | `js/views/*.js` |
| Database schema, RLS, delete functions | `supabase/migrations/001_init.sql` |
| Optional AI generator (Vercel function) | `api/generate.js` |

## Setup

### 1. Supabase (already done for the `StudyDeck` project)

The schema in `supabase/migrations/` (001 and 002) has been applied to project `agynnezilmopxxzkqrzt`. Its URL and **publishable** key are in `js/config.js` — that key is meant to be public; RLS is what protects data. Never put the `service_role`/secret key in this repo.

After you deploy, in the Supabase dashboard go to **Authentication → URL Configuration** and set:

- **Site URL**: your Vercel URL, e.g. `https://studydeck.vercel.app`
- **Redirect URLs**: add the same URL (and `http://localhost:3000` if you run it locally)

Otherwise confirmation and password-reset emails will link to `localhost`.

Optional: **Authentication → Providers → Email** — turn off *Confirm email* if you want people to start without confirming. Supabase's built-in email sender is rate-limited (a few emails per hour); for real use, add SMTP under **Authentication → Emails → SMTP settings**.

### 2. GitHub

```bash
git remote add origin https://github.com/<you>/studydeck.git
git push -u origin main
```

### 3. Vercel

1. **Add New → Project →** import the `studydeck` repo.
2. Framework preset: **Other**. Leave Build Command and Output Directory empty.
3. Deploy. Every push to `main` redeploys automatically.

### 4. (Optional) AI-generated questions

The built-in generator works offline and needs no key. For smarter questions, add these in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-haiku-5-5` |

An "AI" option then appears in the generate dialog for signed-in users. Only the text a user chooses is sent; nothing is stored by the function. API usage is billed to your key.

## Run locally

```bash
npx serve -l 3000 .     # or: python3 -m http.server 3000
```

Open http://localhost:3000. ("Use without an account" works fully offline.)

## Install on a phone / iPad

Open the site, then **Share → Add to Home Screen** (iOS/iPadOS) or **⋮ → Install app** (Android/Chrome). It opens full-screen like an app.

## Privacy notes

- Users can't see each other's data: every table has `user_id = auth.uid()` policies for select/insert/update/delete, verified with two test users.
- As the Supabase project owner you can still technically open the tables in the Supabase dashboard (any hosted database owner can). The app itself never shows you other users' data.
- Supabase's free plan has no point-in-time recovery, so deleted data is gone. (Paid plans keep daily backups for ~7 days at the infrastructure level.)
- The Supabase linter flags `delete_my_account()` as a SECURITY DEFINER function callable by signed-in users. That's intentional: it only ever deletes the caller's own login (`auth.uid()`).
