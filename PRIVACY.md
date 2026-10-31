# Privacy

Putaway has no server, no account and no analytics. Everything it saves stays in
your browser profile on your computer.

## What it saves

- The readable text and title of pages you stay on for 15 seconds, or put away.
- The URLs and titles of tabs you put away or keep in a workspace.
- URLs and titles from the last 90 days of browser history, imported at install.
- Time spent on each page per day, used only for your recap.

## What it never saves

- Anything in incognito windows.
- Page text from banking, mail, messaging, health and password manager sites.
- Page text from sign-in, checkout, billing and other account pages.
- Page text from any page with a password or payment card field.
- Page text from private network addresses such as `localhost` and `192.168.x.x`.
- Page text from any site you add to the block list in Settings.

If you put away a tab from one of these sites, its URL and title are kept in the
box so you can reopen it. Its contents are not saved.

The built-in rules are pattern lists, so they cannot recognise every sensitive
site. Your bank's site may not be on the list. Add anything you want excluded in
Settings, or use Pause.

## Network use

The search model ships inside the extension, so your pages and searches are
processed on your device. Putaway makes one request of its own: a daily check of
the public GitHub releases API for a newer version. It sends no browsing data,
and you can turn it off in Settings.

## Permissions

| Permission | Why |
|---|---|
| Read sites you visit | To save page text for search |
| Tabs and tab groups | To put tabs away, restore them and spot duplicates |
| History | To make recent pages findable by title on day one |
| Scripting | To read tabs that were already open at install |
| Web navigation and web requests | To notice when a page is gone and offer your copy |
| Storage and unlimited storage | To keep your library on this computer |
| Offscreen | To run the search model |
| Alarms | To schedule stale-tab counts and the update check |
| Favicon | To show site icons from the browser's own cache |

## Deleting your data

Use **Delete everything** in Settings. Removing the extension also deletes
everything it stored, so create an encrypted backup first if you want to keep it.
