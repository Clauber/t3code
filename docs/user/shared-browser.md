# Shared browser

A shared browser keeps one set of saved logins on one computer and lets you, your agents, and agents
on other computers use it. It runs on the computer you choose and keeps each profile's cookies there.

Open **Settings → Integrations → Shared browser** (on the phone app: **Settings → Shared browser**).
Choose which computer runs it and which profile to
use, then open a page. **Watch** shows the page live; **Take control** lets you click and type, and
**Release control** hands it back to agents. If you close the viewer while you hold control, control is
kept for you for 30 seconds, then the browser pauses until someone takes control again.

- **Page or full window.** A viewer shows the page by default. **Full window** also shows Chrome's
  toolbar, extension prompts and system dialogs. It is off unless the computer that runs the browser has
  been set up for it; the viewer says why when it is unavailable.
- **On a Mac.** When the T3 desktop app runs the browser on your Mac, it opens as an ordinary Chrome
  window on your screen, so you use it directly instead of through a video of it. **Open on this Mac**
  opens a page there and gives you control. Agents on any computer, and the phone app's page view, keep
  working; they wait while you hold control. **Take control** and **Release control** are also on each tab
  in the list, with no viewer open. Holding control keeps agents from changing the page. It cannot stop
  what you type into the Chrome window itself, so release control when you are done. Google Chrome must
  be installed on the Mac.
- **Who can use it.** **Access** lists the people and devices that may watch (or watch and control) a
  profile, and agents on other computers that may use it. An agent's access is for one chat and expires.
- **Agents finding a shared tab.** Turn **Shared** on for a page and an agent that has access to that
  browser can list it with `preview_shared_tabs` and join it, without anyone passing ids around. Pages
  you did not share are never listed. Tabs you opened stay listed after the computer that runs the
  browser restarts, and are not reloaded or navigated.
- **Another computer's browser.** Add the access code that computer gave you under **Browsers on other
  computers**. The code is a password: it is stored only on this computer and shown once.
- **Updates.** The browser component updates itself when it is not in use. A waiting update says what it
  is waiting for. You can pause updates, keep the current version, go back one version, or recover after
  a failed update.

`localhost` in a page's address means the computer that runs the browser, not the one you are using.
