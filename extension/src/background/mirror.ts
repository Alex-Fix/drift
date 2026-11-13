import { parse, type Message, type Notification } from "../protocol";

/**
 * Which tab each mirroring session belongs to. Media from a content script is forwarded only if it's a valid
 * `video`/`audio` notification for the session of the tab it came from (security skill: the media exception).
 */
export class MirrorSessions {
  private readonly byTab = new Map<number, string>();

  bind(tabId: number, session: string): void {
    this.byTab.set(tabId, session);
  }

  unbind(tabId: number): string | undefined {
    const session = this.byTab.get(tabId);
    this.byTab.delete(tabId);
    return session;
  }

  session(tabId: number): string | undefined {
    return this.byTab.get(tabId);
  }

  tabOf(session: string): number | undefined {
    for (const [tabId, bound] of this.byTab) if (bound === session) return tabId;
    return undefined;
  }

  accept(tabId: number | undefined, raw: unknown): Notification | undefined {
    if (tabId === undefined || typeof raw !== "object" || raw === null) return undefined;
    const session = this.byTab.get(tabId);
    if (session === undefined) return undefined;
    let message: Message;
    try {
      message = parse({ ...raw, v: 1 });
    } catch {
      return undefined;
    }
    if ((message.type !== "video" && message.type !== "audio") || message.session !== session) return undefined;
    return message; // its `v` is replaced when the client sends it
  }
}
