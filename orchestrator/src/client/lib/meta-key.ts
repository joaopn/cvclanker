interface NavigatorLike {
  platform?: string;
  userAgent?: string;
}

const isApplePlatform = (value: string) =>
  /(mac|iphone|ipad|ipod)/i.test(value);

const getRuntimeNavigator = (): NavigatorLike | null => {
  if (typeof navigator === "undefined") return null;
  return navigator;
};

export const getMetaKeyLabel = (
  nav: NavigatorLike | null = getRuntimeNavigator(),
) => {
  const platform = nav?.platform ?? "";
  const userAgent = nav?.userAgent ?? "";
  return isApplePlatform(`${platform} ${userAgent}`) ? "⌘" : "Ctrl";
};

export const getMetaShortcutLabel = (
  key: string,
  nav: NavigatorLike | null = getRuntimeNavigator(),
) => {
  const normalizedKey = key.trim().toUpperCase();
  const meta = getMetaKeyLabel(nav);
  return meta === "⌘" ? `${meta}${normalizedKey}` : `${meta}+${normalizedKey}`;
};
