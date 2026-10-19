# Temavrix's Monolithic Server

Our Single deployable server that supports day to day operations of Temavrix's internal services such as APIs, User Management, Database and Redis Managament etc.

```
Temalith Changelogs:-

ANNOUNCEMENT:- 

1. Enhanced Nuvin Support
    1.1 Added Firebase Support
2. Commented unused (Nexaview) support code

Code Checks Manifest:-
BackEnd Code Checks: ✅
(All evaluations are done by the R&D Department)

Last Updated: 19-Oct-2026 12:35 HRS (Singapore Standard Time)
Publisher: Temavrix
```
Keep up-to-date with what's happening on this repository by clicking the 'Star' and 'Watch' button on the top right corner of this repository.


## Nexaview
For users who want to only use this for Nexaview's backend you can delete the uncommented code and then uncomment all the commented code and run `npm run dev` and your Temalith server is running successfully on port 5000.

Configure Nexaview's environment variables in config.env by adding your private API keys.


## Nuvin
For users trying to test Nuvin's backend you need to provision a firebase database and download `firebase-service-account.json` and put in this project.  
Next you will need to run `npm run dev` and your Temalith server is running successfully on port 5000. Now you need to authorize your Gmail account and call the email endpoint.
#### Step 1: Connect your Gmail account
Open this URL in your browser:
http://localhost:5000/api/gmail/login

1. Sign in to your Google account.
2. Grant Nuvin permission to read Gmail.
3. You should see a success message after Google redirects you to /api/gmail/callback.

If Google shows 403 access_denied, add your Gmail address under Google Cloud → Google Auth Platform → Audience → Test users.

#### Step 2: Fetch your emails
Once authorization succeeds, open:
http://localhost:5000/api/gmail