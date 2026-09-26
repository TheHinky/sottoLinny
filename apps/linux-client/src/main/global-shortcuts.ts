// Global shortcuts through the xdg-desktop-portal GlobalShortcuts interface.
// Electron's globalShortcut works on Wayland but registers hash IDs with generic
// names and new entries per launch; talking to the portal directly gives stable
// IDs, readable names in KDE System Settings, and key-release events.
import dbus, { Variant, type MessageBus } from "dbus-next";

const portalName = "org.freedesktop.portal.Desktop";
const portalPath = "/org/freedesktop/portal/desktop";

// dbus-next types proxy methods as an untyped index signature; describe the
// portal methods used here instead.
type Options = Record<string, Variant>;
type GlobalShortcutsPortal = dbus.ClientInterface & {
  CreateSession(options: Options): Promise<string>;
  BindShortcuts(
    session: string,
    shortcuts: [string, Options][],
    parentWindow: string,
    options: Options,
  ): Promise<string>;
};
type RegistryPortal = dbus.ClientInterface & {
  Register(appId: string, options: Options): Promise<void>;
};
// Unique connection name (":1.42"); set once the bus has connected, which
// getProxyObject waits for. Missing from dbus-next's type declarations.
const uniqueName = (bus: MessageBus) => (bus as MessageBus & { name: string | null }).name;

export type ShortcutDefinition = { id: string; description: string; trigger: string };
export type ShortcutHandlers = {
  activated(id: string): void;
  deactivated?(id: string): void;
};

// ---- Portal request helper ----
// Portal methods return a Request object path; the result arrives later as a
// Response signal on that path. Subscribe before calling to avoid a race.
async function request(
  bus: MessageBus,
  call: (token: string) => Promise<unknown>,
): Promise<Record<string, Variant>> {
  const token = `sotto_${crypto.randomUUID().replaceAll("-", "")}`;
  const name = uniqueName(bus);
  if (!name) throw new Error("D-Bus connection has no name.");
  const sender = name.slice(1).replaceAll(".", "_");
  const path = `${portalPath}/request/${sender}/${token}`;
  const match = `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${path}'`;
  await addMatch(bus, match);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Shortcut portal did not respond."));
      }, 60_000); // BindShortcuts can wait for a user confirmation dialog.
      const onMessage = (message: dbus.Message) => {
        if (message.path !== path || message.member !== "Response") return;
        cleanup();
        const [code, results] = message.body as [number, Record<string, Variant>];
        if (code === 0) resolve(results);
        else reject(new Error(code === 1 ? "Shortcuts were declined." : "Shortcut portal failed."));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        bus.removeListener("message", onMessage);
      };
      bus.on("message", onMessage);
      call(token).catch((error: unknown) => {
        cleanup();
        reject(error);
      });
    });
  } finally {
    await removeMatch(bus, match).catch(() => {});
  }
}

async function busCall(bus: MessageBus, member: string, signature: string, body: unknown[]) {
  return bus.call(
    new dbus.Message({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member,
      signature,
      body,
    }),
  );
}
const addMatch = (bus: MessageBus, rule: string) => busCall(bus, "AddMatch", "s", [rule]);
const removeMatch = (bus: MessageBus, rule: string) => busCall(bus, "RemoveMatch", "s", [rule]);

// ---- Registration ----
// Returns a disposer. Throws when the portal is missing or refuses the app.
export async function registerGlobalShortcuts(
  appId: string,
  shortcuts: ShortcutDefinition[],
  handlers: ShortcutHandlers,
): Promise<() => void> {
  const bus = dbus.sessionBus();
  try {
    const portal = await bus.getProxyObject(portalName, portalPath);

    // Host (non-Flatpak) apps must declare their app ID before using portals;
    // it has to match an installed .desktop file.
    await portal
      .getInterface<RegistryPortal>("org.freedesktop.host.portal.Registry")
      .Register(appId, {});

    const globalShortcuts = portal.getInterface<GlobalShortcutsPortal>(
      "org.freedesktop.portal.GlobalShortcuts",
    );
    const session = await request(bus, (token) =>
      globalShortcuts.CreateSession({
        handle_token: new Variant("s", token),
        session_handle_token: new Variant("s", "sotto"),
      }),
    );
    const sessionHandle = session.session_handle?.value;
    if (typeof sessionHandle !== "string") throw new Error("Shortcut portal returned no session.");

    globalShortcuts.on("Activated", (handle: string, id: string) => {
      if (handle === sessionHandle) handlers.activated(id);
    });
    globalShortcuts.on("Deactivated", (handle: string, id: string) => {
      if (handle === sessionHandle) handlers.deactivated?.(id);
    });

    await request(bus, (token) =>
      globalShortcuts.BindShortcuts(
        sessionHandle,
        shortcuts.map(({ id, description, trigger }): [string, Options] => [
          id,
          {
            description: new Variant("s", description),
            preferred_trigger: new Variant("s", trigger),
          },
        ]),
        "",
        { handle_token: new Variant("s", token) },
      ),
    );
    return () => bus.disconnect();
  } catch (error) {
    bus.disconnect();
    throw error;
  }
}
