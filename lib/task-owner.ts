import { currentUser } from "./web-auth";
import { AppError } from "./http";
export async function taskOwner(required = false) {
  const user = await currentUser();
  if (!user && required) throw new AppError("请先登录网站账号。", 401);
  return user?.id || null;
}
