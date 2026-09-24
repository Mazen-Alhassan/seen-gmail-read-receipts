/**
 * Gmail tabs that were open before this version was installed are running an old copy of the
 * content script (or none), and would send email untracked. Refresh them — but never one with a
 * compose window open, so nothing you're typing is interrupted.
 */
export async function refreshIdleGmailTabs(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/mail/*" });
  const refreshed = await Promise.all(
    tabs.map(async (tab) => {
      // Never the tab you're looking at or one playing sound (e.g. a Meet/Chat call): those get
      // the in-page "Seen was updated" message and refresh themselves once you switch away.
      if (tab.id === undefined || tab.discarded || tab.active || tab.audible) return false;
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          // Busy if something is being written: a compose window, a focused field, an open dialog.
          func: () => {
            const a = document.activeElement as HTMLElement | null;
            const typing =
              !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "IFRAME" || a.isContentEditable);
            const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"]')].some(
              (d) => d.offsetParent !== null,
            );
            return !!document.querySelector('[g_editable="true"]') || typing || dialog;
          },
        });
        if (res?.result !== false) return false;
        await chrome.tabs.reload(tab.id);
        return true;
      } catch {
        return false; // can't be scripted right now; the in-page "refresh Gmail" notice covers it
      }
    }),
  );
  return refreshed.filter(Boolean).length;
}
