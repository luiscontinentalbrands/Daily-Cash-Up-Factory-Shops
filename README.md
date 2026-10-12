# Factory Shop Cash Up — Continental Brands

A secure, live, shared daily cash up for the factory shop.

- **Website** on GitHub Pages: staff open it on any phone, tablet or PC.
- **Data** in Google Firebase: every change shows up live for everyone, and nothing is stored on the phone.
- **Emails** from GitHub Actions: at 7 pm Ulla is alerted if a signature is missing and Martie gets the day's report. At 9 pm Martie gets the final report if the day was signed late.

---

## How it is secured

| Protection | What it does |
|---|---|
| Personal logins | Every staff member signs in with their own email and password. There are no shared passwords. |
| Staff list | Only people on the `staff` list in Firebase can see anything. If someone creates an account on their own, they still see nothing. |
| Roles | Wholesale cashiers sign only Wholesale, and Retail cashiers sign only Retail. Only a manager signs off the day. |
| Separation of duties | The manager who signs off the day must be a different person from the cashiers who signed the sheets. |
| Locked after signing | A signed sheet can't be changed. Reopening it removes the signature, so it must be signed again. Once the manager has closed the day, only the manager can reopen it. |
| Server time | Signature times come from Google's clock, not the phone's, so they can't be back-dated. |
| Audit trail | Every signature and reopen is logged with who did it and when. Nobody, not even an admin, can edit or delete the log. |
| Auto sign-out | Staff are signed out after 15 minutes without using the app, and when the browser is closed. |
| Rules on the server | The protections are enforced by Firebase's security rules in `firestore.rules`, not just by the website. Someone tampering with the website code still can't get past them. |
| No secrets in the code | The email password and Firebase server key live only in GitHub's encrypted *Secrets*. |

The values in `firebase-config.js` are **not** passwords. They only tell the app which Firebase project to connect to, and Google publishes them openly. Your data is protected by the logins and the rules.

---

## One-time setup (about 45 minutes)

### Part 1 — Create the Firebase project

1. Go to **https://console.firebase.google.com** and sign in with the company Google account.
2. Click **Create a project** and name it `cbm-cashup`. You can switch Google Analytics off.
3. **Turn on logins:** left menu **Build → Authentication → Get started → Email/Password → Enable → Save**.
4. **Create the database:** **Build → Firestore Database → Create database**.
   - Location: **africa-south1 (Johannesburg)**. This can't be changed later.
   - Choose **Start in production mode**.
5. **Add the security rules:** in Firestore, open the **Rules** tab, delete everything in it, paste in the whole of `firestore.rules`, and click **Publish**.
6. **Register the website:** click the gear icon **⚙ → Project settings → General → Your apps → `</>` (Web)**. Name it `Cash Up` and click **Register app**. You'll see a block of settings like `apiKey: "..."`. Copy each value into `firebase-config.js`.

### Part 2 — Put the website on GitHub

1. Sign in to **https://github.com** and click **New repository**.
   - Name: `cashup`.
   - **Public** is fine and free, because no secrets are in the code. A **Private** repository with GitHub Pages needs a paid GitHub plan.
2. Click **uploading an existing file**. Drag in **all** the files and folders from this package, including the hidden `.github` folder, then click **Commit changes**.
   - If the `.github` folder doesn't upload by dragging, create it by hand: **Add file → Create new file**, type `.github/workflows/cashup-daily-check.yml` as the name, and paste in the file's contents.
3. **Switch on the website:** **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
   - After a minute or two your app is live at `https://YOUR-GITHUB-NAME.github.io/cashup/`.
4. **Let Firebase accept logins from that address:** in Firebase, go to **Authentication → Settings → Authorized domains → Add domain** and enter `YOUR-GITHUB-NAME.github.io`.

### Part 3 — Add your staff

Do this for each person: cashiers, managers, and yourself as admin.

1. Firebase → **Authentication → Users → Add user**. Enter their email and a temporary password.
2. Copy their **User UID**, the long code in the user list.
3. Firebase → **Firestore Database → Data → Start collection** (only the first time). Name the collection `staff`.
4. Add a document:
   - **Document ID:** paste the User UID.
   - Add three fields:

| Field | Type | Value |
|---|---|---|
| `name` | string | Their full name as it should appear on signatures, e.g. `Zandile Mokoena` |
| `role` | string | One of `wholesale`, `retail`, `manager`, `admin` |
| `active` | boolean | `true` |

5. Send them the app link and their temporary password. They can choose their own password with **Forgot password?** on the sign-in screen.

**When someone leaves:** set `active` to `false` in their staff record. Their access stops at once, and their past cash ups and signatures stay in History. You can also disable the login under Authentication → Users.

**Roles explained**

- `wholesale`: fills in and signs the Wholesale sheet.
- `retail`: fills in and signs the Retail sheet.
- `manager`: can fill in either sheet, can reopen sheets, and signs off the day.
- `admin`: everything, plus deleting a day. Give this to as few people as possible.

### Part 4 — Switch on the 7 pm and 9 pm emails

The emails are sent from a Gmail account by GitHub. They need two secrets.

**A. Firebase server key**

1. Firebase → **⚙ Project settings → Service accounts → Generate new private key → Generate key**. A `.json` file downloads.
2. GitHub → your `cashup` repository → **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: open the `.json` file in Notepad and paste **everything** in it.
3. **Delete the downloaded `.json` file** from your computer. Never upload it to the repository.

**B. Gmail app password**

1. Use the Gmail account the emails should come from, for example luiscontinentalbrands@gmail.com.
2. Google Account → **Security**. Turn on **2-Step Verification** if it isn't on already.
3. Search for **App passwords**, create one called `Cash Up`, and copy the 16-character password.
4. In GitHub, add two more secrets:
   - `SMTP_USER` = the Gmail address
   - `SMTP_PASS` = the 16-character app password

**C. Test it**

GitHub → **Actions → Cash up daily check → Run workflow**. Choose mode `seven` and click **Run workflow**. Within a minute or two Ulla and Martie should get an email. You can enter a past date to test with real data.

After that it runs by itself at **19:05** and **21:00**, Monday to Saturday. GitHub sometimes starts scheduled runs a few minutes late. The 7 pm check still judges each signature by the time it was made, not by when the job ran.

> GitHub pauses scheduled jobs in a repository with no activity for 60 days. If the emails stop, go to **Actions** and click **Enable workflow**.

### Part 5 — Extra lock-down (recommended)

- **Restrict the web key to your site:** open **https://console.cloud.google.com/apis/credentials** and select the Firebase project. Click the **Browser key** and under **Application restrictions** choose **Websites**. Add `https://YOUR-GITHUB-NAME.github.io/*` and Save.
- **Stop self-sign-ups:** Firebase → Authentication → **Settings → User actions** → untick **Enable create (sign-up)**. Self-created accounts already see nothing, but this stops them existing at all.
- **Two-step login for managers and admins:** available after upgrading Authentication to *Identity Platform* (Authentication → Settings).

---

## Daily use

1. Open the app link and sign in.
2. **Wholesale / Retail cashier:** open your tab and enter **Per report** (the till / Z-report) and **Deposited** (actually counted) for each payment type. Add any damaged notes and coins and a note explaining any variance, then sign in the box and tap **Sign & submit**.
3. **Manager:** open **End of Day**, check the combined figures, and sign. Everything must be signed by **7 pm** (Monday to Saturday).
4. **Sign out** when you're done, especially on a shared device.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The website |
| `firebase-config.js` | Which Firebase project to use (fill this in) |
| `firestore.rules` | The security rules (paste into Firebase) |
| `.github/workflows/cashup-daily-check.yml` | The 7 pm / 9 pm schedule |
| `scripts/daily-check.mjs` | Builds and sends the emails |

## Firebase cost

At one shop's volume (a few hundred reads and writes a day), this stays well inside Firebase's free **Spark** plan. GitHub Pages and GitHub Actions are free for this use.
