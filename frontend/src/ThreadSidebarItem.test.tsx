import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { ThreadSidebarItem } from "./ThreadSidebarItem";
import { ConfirmProvider } from "./ui";

function renderItem(overrides: Partial<Parameters<typeof ThreadSidebarItem>[0]> = {}) {
  const props: Parameters<typeof ThreadSidebarItem>[0] = {
    thread: {
      id: "thread_1",
      title: "Fix the poller",
      label: "Fix the poller — Next Coder",
      projectId: "project_1",
      status: "running",
    },
    active: true,
    status: "running",
    onSelect: vi.fn(),
    onRename: vi.fn().mockResolvedValue(true),
    onArchive: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  render(
    <ConfirmProvider>
      <ThreadSidebarItem {...props} />
    </ConfirmProvider>,
  );
  return props;
}

describe("ThreadSidebarItem", () => {
  test("renames a thread from its labelled overflow menu", async () => {
    const props = renderItem();

    fireEvent.click(screen.getByRole("button", { name: "Thread actions for Fix the poller" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByRole("textbox", { name: "Thread name" });
    expect(input).toHaveValue("Fix the poller");
    fireEvent.change(input, { target: { value: "Repair snapshot polling" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("Repair snapshot polling"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename thread" })).not.toBeInTheDocument());
  });

  test("confirms archive as recoverable and delete as permanent", async () => {
    const props = renderItem();

    fireEvent.click(screen.getByRole("button", { name: "Thread actions for Fix the poller" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(screen.getByText(/restored from T3 Code/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Archive thread" }));
    await waitFor(() => expect(props.onArchive).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Thread actions for Fix the poller" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText(/cannot be undone/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete thread" }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledTimes(1));
  });
});
