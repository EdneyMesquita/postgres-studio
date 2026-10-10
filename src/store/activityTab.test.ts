import { beforeEach, describe, expect, it } from "vitest";
import { tabName } from "../components/tabs/tabName";
import { useSessionsStore } from "./sessionsStore";

const conn = { id: "c1", name: "Local", summary: "localhost:5433" };

describe("openActivity", () => {
  beforeEach(() => useSessionsStore.setState({ tabs: [], activeTabId: null }));

  it("opens one activity tab per connection and database", () => {
    const { openActivity } = useSessionsStore.getState();
    openActivity(conn, "shop");
    openActivity(conn, "shop");
    openActivity(conn, "analytics");
    const tabs = useSessionsStore.getState().tabs;
    expect(tabs.map((t) => t.id)).toEqual(["activity:c1/shop", "activity:c1/analytics"]);
    expect(useSessionsStore.getState().activeTabId).toBe("activity:c1/analytics");
    expect(tabName(tabs[0])).toBe("shop activity");
  });

  it("focuses the tab already open", () => {
    const { openActivity, activateTab } = useSessionsStore.getState();
    openActivity(conn, "shop");
    openActivity(conn, "analytics");
    activateTab("activity:c1/analytics");
    openActivity(conn, "shop");
    expect(useSessionsStore.getState().activeTabId).toBe("activity:c1/shop");
  });
});
