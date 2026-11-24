export function getWebLoginConfig() {
  const user = process.env.BASIC_AUTH_USER || "";
  const pass = process.env.BASIC_AUTH_PASSWORD || "";
  return {
    user,
    pass,
    enabled: user.length > 0 && pass.length > 0,
  };
}
