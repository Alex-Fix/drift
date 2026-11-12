import type { Request } from "../protocol";
import { HOST_NAME, NativeClient } from "./native";

/** Popup → background. Only extension pages may talk to the host; content scripts and web pages may not. */
export interface HostCall {
  kind: "host";
  request: Request;
}

const client = new NativeClient(
  () => chrome.runtime.connectNative(HOST_NAME),
  (event) => {
    // The popup may be closed: nobody listening is fine.
    chrome.runtime.sendMessage({ kind: "status", event }).catch(() => undefined);
  },
);

const fromExtensionPage = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id &&
  sender.tab === undefined &&
  sender.url?.startsWith(chrome.runtime.getURL("")) === true;

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!fromExtensionPage(sender) || typeof message !== "object" || message === null) return false;
  const call = message as Partial<HostCall>;
  if (call.kind !== "host" || call.request === undefined) return false;
  client.request(call.request).then(
    (response) => {
      sendResponse({ ok: true, response });
    },
    (error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "drift-host failed" });
    },
  );
  return true; // answered asynchronously
});
