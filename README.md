# Factory Shop Cash Up — Continental Brands

A secure, live, shared daily cash up for the factory shop.

- **Website** on GitHub Pages: staff open it on any phone, tablet or PC.
- **Data** in Google Firebase: every change shows up live for everyone, and nothing is stored on the phone.
- **Emails** from GitHub Actions: at 7 pm Ulla is alerted if a signature is missing and Martie gets the day's report. At 9 pm Martie gets the final report if the day was signed late.

---

## How it is secured

There are no email logins. Each device is set up once with the shop's **secret access code**, and each person picks their name and enters a PIN that the administrator gives them in the app.

| Protection | What it does |
|---|---|
| Secret access code | The database refuses to read or change anything unless the request carries the shop's code. The code is 24 random characters, so it can't be guessed. It lives only in the Firebase rules and on set-up devices, never in this repository. |
| Locked after signing | A signed sheet can't be changed. Reopening removes the signature, is recorded in the audit trail, and the sheet must be signed again. Once the manager closes the day, a sheet can only be reopened by first reopening the day. |
| Independent manager sign-off | The manager's name must be different from the cashiers who signed. |
| Server time | Signature times come from Google's clock, not the phone's, so they can't be back-dated. |
| Audit trail | Every signature and reopen is logged. Nobody can edit or delete the log. |
| No deletes | Nothing can be deleted from the app. |

**Keep the setup link private, like a till key.** Anyone holding a set-up device can use the cash up. If a device is lost or someone leaves, change the code (see *Changing the access code* below).

## One-time setup (about 45 minutes)

### Part 1 — Create the Firebase project

1. Go to **https://console.firebase.google.com** and sign in with the company Google account.
2. Click **Create a project** and name it `cbm-cashup`. You can switch Google Analytics off.
4. **Create the database:** **Build → Firestore Database → Create database**.
   - Location: **africa-south1 (Johannesburg)**. This can't be changed later.
   - Choose **Start in production mode**.
5. **Add the security rules:** in Firestore, open the **Rules** tab, delete everything in it, paste in the whole of `firestore.rules`, replace `PASTE_SHOP_ACCESS_CODE` with your access code, and click **Publish**. Don't put the real code back into GitHub.
6. **Register the website:** click the gear icon **⚙ → Project settings → General → Your apps → `</>` (Web)**. Name it `Cash Up` and click **Register app**. You'll see a block of settings like `apiKey: "..."`. Copy each value into `firebase-config.js`.

### Part 2 — Put the website on GitHub

1. Sign in to **https://github.com** and click **New repository**.
   - Name: `cashup`.
   - **Public** is fine and free, because no secrets are in the code. A **Private** repository with GitHub Pages needs a paid GitHub plan.
2. Click **uploading an existing file**. Drag in **all** the files and folders from this package, including the hidden `.github` folder, then click **Commit changes**.
   - If the `.github` folder doesn't upload by dragging, create it by hand: **Add file → Create new file**, type `.github/workflows/cashup-daily-check.yml` as the name, and paste in the file's contents.
3. **Switch on the website:** **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
   - After a minute or two your app is live at `https://YOUR-GITHUB-NAME.github.io/cashup/`.

### Part 3 — Set up devices and people

1. Open the **setup link** (the app address followed by `#join-` and the access code) once on each device: till PCs, tablets, phones. The device remembers the code.
2. The first time, the app asks you to **create the administrator**: your name and a 4-digit PIN.
3. As administrator, open the **Users** tab and add each person with their name, role (Wholesale cashier, Retail cashier, Manager) and a 4-digit PIN. Give each person their PIN privately.
4. Staff open the app, tap their name and enter their PIN. Their name goes on their sheet and signature automatically. The app locks after 15 minutes without use; **Switch user** at the top changes person.
5. When someone leaves, tap **Switch off** next to their name. Their past cash ups stay in History.

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
4. In GitHub, add three more secrets:
   - `SMTP_USER` = the Gmail address
   - `SMTP_PASS` = the 16-character app password
   - `SHOP_KEY` = the shop access code

**C. Test it**

GitHub → **Actions → Cash up daily check → Run workflow**. Choose mode `seven` and click **Run workflow**. Within a minute or two Ulla and Martie should get an email. You can enter a past date to test with real data.

After that it runs by itself at **19:05** and **21:00**, Monday to Saturday. GitHub sometimes starts scheduled runs a few minutes late. The 7 pm check still judges each signature by the time it was made, not by when the job ran.

> GitHub pauses scheduled jobs in a repository with no activity for 60 days. If the emails stop, go to **Actions** and click **Enable workflow**.

### Part 5 — Extra lock-down (recommended)

- **Restrict the web key to your site:** open **https://console.cloud.google.com/apis/credentials** and select the Firebase project. Click the **Browser key** and under **Application restrictions** choose **Websites**. Add `https://YOUR-GITHUB-NAME.github.io/*` and Save.

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
