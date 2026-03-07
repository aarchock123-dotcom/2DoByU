# 2DoByU Testing Guide

This file is a quick index for manual smoke-test checklists.

## Smoke Test Checklists

- Auth flow: `AUTH_SMOKE_TEST_CHECKLIST.md`

## When To Run

Run auth smoke tests after changes to:

- `js/api.js` (sign-in, sign-up, sign-out, auth state handling)
- `js/ui.js` (auth gate rendering, auth actions, visibility)
- `js/state.js` (default auth gate state)
- `css/components.css` (auth gate and modal styling)

## Suggested Process

1. Run the auth checklist once in desktop width.
2. Run key auth checks again in mobile width.
3. Re-test logout and refresh behavior before shipping.
