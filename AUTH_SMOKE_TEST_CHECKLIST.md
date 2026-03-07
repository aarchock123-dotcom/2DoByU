# 2DoByU Auth Smoke Test Checklist

Use this checklist after auth-related UI or state changes.

## Environment

- Test in a normal browser tab (not private mode first).
- Use browser devtools network tab to confirm online/offline behavior.
- Have one test account available in Supabase Auth.

## Core Login Flow

1. Open the app while signed out.
- Expected: Full auth screen is shown.
- Expected: App shell is hidden (no task board behind login UI).
- Expected: Sign-in form is visible by default.

2. Try invalid sign-in credentials.
- Expected: Error message is shown.
- Expected: You remain on the sign-in form.
- Expected: No partial app content is shown.

3. Sign in with valid credentials.
- Expected: Auth screen closes.
- Expected: Main app shell appears.
- Expected: Current view defaults to Task Board.

## Logout Flow

4. Click Settings -> Sign Out.
- Expected: You are returned to auth screen immediately.
- Expected: Sign-in form is shown (not a small chooser popup state).
- Expected: Message appears: "You have been signed out. Sign in to continue."

5. Refresh while signed out.
- Expected: Auth screen still appears.
- Expected: Sign-in form is still the default state.

## Sign-up Flow

6. From auth screen, choose Create Account.
- Expected: Sign-up form is shown.

7. Submit valid sign-up data.
- Expected: Either signed in immediately or prompted to verify email.
- Expected: If email verification is required, informational message is shown.

8. Submit weak password (< 6 chars).
- Expected: Friendly password validation message is shown.

## Keyboard and UX

9. Press Enter in email/password fields.
- Expected: Submits the active auth form.

10. While auth screen is visible, press Escape.
- Expected: Auth screen remains (should not bypass auth).

## Offline Guardrail

11. Turn network off and reload while signed out.
- Expected: Auth UI still appears.
- Expected: No broken modal or popup behavior.

12. Turn network on and sign in again.
- Expected: Sign-in succeeds and app unlocks normally.

## Regression Flags

Treat any of the following as a regression:

- Login appears as a tiny modal over an interactive app shell.
- Signed-out state lands on wrong gate step unexpectedly.
- Auth state flickers between signed-in and signed-out screens.
- Sign-out does not return to sign-in form.
