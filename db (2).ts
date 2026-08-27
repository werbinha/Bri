import { and, desc, eq, gt, inArray, like, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  comments,
  connections,
  InsertUser,
  likes,
  memberSessions,
  notifications,
  personas,
  playlistTracks,
  posts,
  profilePlaylists,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getLevelProgression, MAX_XP } from "./progression";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export function toPublicMember(user: typeof users.$inferSelect) {
  const parseJson = <T>(value: string | null, fallback: T): T => {
    try {
      return value ? (JSON.parse(value) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatarUrl: user.avatarUrl,
    avatarMediaType: user.avatarMediaType,
    bannerUrl: user.bannerUrl,
    bannerMediaType: user.bannerMediaType,
    bio: user.bio,
    campusPosition: user.campusPosition,
    profileBg: user.profileBg,
    profileBgImage: user.profileBgImage,
    cardImage: user.cardImage,
    backgroundMode: user.backgroundMode,
    feedTheme: user.feedTheme,
    feedBackgroundImage: user.feedBackgroundImage,
    cardColor: user.cardColor,
    neonColor: user.neonColor,
    borderColor: user.borderColor,
    profileSong: user.profileSong,
    decorativeBorder: user.decorativeBorder,
    avatarFrame: user.avatarFrame,
    ...getLevelProgression(user.xp),
    levelTagColor: user.levelTagColor,
    profileStatus: user.profileStatus,
    profileTags: parseJson(
      user.profileTags,
      [] as Array<{
        id: string;
        label: string;
        background: string;
        color: string;
      }>
    ),
    profileHighlights: parseJson(
      user.profileHighlights,
      [] as Array<{
        id: string;
        title: string;
        coverUrl: string | null;
        emoji: string;
      }>
    ),
    floatingEffect: user.floatingEffect,
    floatingEffectIntensity: user.floatingEffectIntensity,
    floatingEffectSpeed: user.floatingEffectSpeed,
    floatingEffectSize: user.floatingEffectSize,
    floatingEffectX: user.floatingEffectX,
    floatingEffectY: user.floatingEffectY,
    createdAt: user.createdAt,
  };
}

export function toSessionMember(user: typeof users.$inferSelect) {
  return { ...toPublicMember(user), email: user.email };
}

export function hasPublicUsername(member: {
  username: string | null | undefined;
}): member is { username: string } {
  return Boolean(member.username?.trim());
}

export async function createLocalMember(input: {
  name: string;
  email: string;
  username: string;
  passwordHash: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const now = new Date();
  const result = await db.insert(users).values({
    openId: `local_${crypto.randomUUID()}`,
    name: input.name,
    email: input.email,
    username: input.username,
    passwordHash: input.passwordHash,
    loginMethod: "password",
    lastSignedIn: now,
  });
  const insertedId = Number(result[0].insertId);
  const member = await getMemberById(insertedId);
  if (!member) throw new Error("Não foi possível criar a conta");
  return member;
}

export async function findMemberByEmailOrUsername(identifier: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select()
    .from(users)
    .where(or(eq(users.email, identifier), eq(users.username, identifier)))
    .limit(1);
  return result[0] ?? null;
}

export async function getMemberById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0] ?? null;
}

export async function getMemberByUsername(username: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return result[0] ?? null;
}

export async function createMemberSession(
  userId: number,
  tokenHash: string,
  expiresAt: Date
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  await db.insert(memberSessions).values({ userId, tokenHash, expiresAt });
}

export async function getMemberBySessionHash(tokenHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select({ member: users })
    .from(memberSessions)
    .innerJoin(users, eq(memberSessions.userId, users.id))
    .where(
      and(
        eq(memberSessions.tokenHash, tokenHash),
        gt(memberSessions.expiresAt, new Date())
      )
    )
    .limit(1);
  return result[0]?.member ?? null;
}

export async function clearMemberSession(tokenHash: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .delete(memberSessions)
    .where(eq(memberSessions.tokenHash, tokenHash));
}

export async function updateMemberProfile(
  userId: number,
  profile: Partial<typeof users.$inferInsert>
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  await db.update(users).set(profile).where(eq(users.id, userId));
  const member = await getMemberById(userId);
  if (!member) throw new Error("Perfil não encontrado");
  return member;
}

export async function createPost(
  authorId: number,
  body: string,
  imageUrl?: string | null,
  mediaType: "image" | "video" = "image",
  personaId: number | null = null,
  audienceIdentity: "member" | "persona" | "anonymous" = "member",
  visibility: "public" | "connections" | "private" = "public"
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .insert(posts)
    .values({
      authorId,
      body,
      imageUrl: imageUrl || null,
      mediaType,
      personaId,
      audienceIdentity,
      visibility,
    });
  return Number(result[0].insertId);
}

export async function addMemberXp(userId: number, amount: number) {
  const db = await getDb();
  if (!db || amount <= 0) return null;
  const before = await getMemberById(userId);
  if (!before) return null;
  await db
    .update(users)
    .set({ xp: sql`LEAST(${users.xp} + ${amount}, ${MAX_XP})` })
    .where(eq(users.id, userId));
  const updated = await getMemberById(userId);
  if (!updated) return null;
  const previousProgression = getLevelProgression(before.xp);
  const progression = getLevelProgression(updated.xp);
  return {
    ...progression,
    leveledUp: progression.level > previousProgression.level,
  };
}

async function canViewPost(post: typeof posts.$inferSelect, viewerId?: number) {
  if (post.visibility === "public" || viewerId === post.authorId) return true;
  if (post.visibility === "private") return false;
  if (!viewerId) return false;
  const connection = await getConnectionBetween(post.authorId, viewerId);
  return connection?.status === "accepted";
}

function makeRestrictedPreview(post: typeof posts.$inferSelect) {
  const accents = ["#00f0ff", "#9d00ff", "#ff5fd2", "#9bf7ff"];
  return {
    body: post.body.slice(0, 280),
    imageUrl: post.imageUrl,
    mediaType: post.mediaType,
    accent: accents[post.id % accents.length]!,
  };
}

export async function viewerCanAccessPost(postId: number, viewerId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select()
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return rows[0] ? canViewPost(rows[0], viewerId) : false;
}

async function enrichPosts(
  feed: Array<{
    post: typeof posts.$inferSelect;
    author: typeof users.$inferSelect;
  }>,
  viewerId?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const postIds = feed.map(item => item.post.id);
  if (postIds.length === 0) return [];
  const personaIds = feed
    .map(item => item.post.personaId)
    .filter((id): id is number => Boolean(id));
  const [allLikes, allComments, listedPersonas] = await Promise.all([
    db.select().from(likes).where(inArray(likes.postId, postIds)),
    db.select().from(comments).where(inArray(comments.postId, postIds)),
    personaIds.length
      ? db.select().from(personas).where(inArray(personas.id, personaIds))
      : Promise.resolve([]),
  ]);
  const personaById = new Map(
    listedPersonas.map(persona => [persona.id, persona])
  );
  return Promise.all(
    feed.map(async ({ post, author }) => {
      const canView = await canViewPost(post, viewerId);
      return {
        ...post,
        body: canView ? post.body : "Conteúdo reservado para quem tem acesso.",
        imageUrl: canView ? post.imageUrl : null,
        mediaType: canView ? post.mediaType : ("image" as const),
        isRestricted: !canView,
        restrictedPreview: canView ? null : makeRestrictedPreview(post),
        author:
          post.audienceIdentity === "anonymous"
            ? {
                id: 0,
                name: "Anônimo",
                username: null,
                avatarUrl: null,
                avatarMediaType: "image" as const,
                campusPosition: "Recado anônimo",
              }
            : post.audienceIdentity === "persona" &&
                post.personaId &&
                personaById.get(post.personaId)
              ? {
                  id: -post.personaId,
                  name: personaById.get(post.personaId)!.name,
                  username: personaById.get(post.personaId)!.username,
                  avatarUrl: personaById.get(post.personaId)!.avatarUrl,
                  avatarMediaType: "image" as const,
                  campusPosition: "Persona Briar",
                }
              : toPublicMember(author),
        personaUsername:
          post.audienceIdentity === "persona" && post.personaId
            ? personaById.get(post.personaId)?.username || null
            : null,
        likeCount: allLikes.filter(like => like.postId === post.id).length,
        commentCount: allComments.filter(comment => comment.postId === post.id)
          .length,
        likedByViewer: viewerId
          ? allLikes.some(
              like => like.postId === post.id && like.userId === viewerId
            )
          : false,
        isAuthor: viewerId === post.authorId,
      };
    })
  );
}

export async function listFeed(viewerId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const feed = await db
    .select({ post: posts, author: users })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .orderBy(desc(posts.createdAt))
    .limit(60);
  return enrichPosts(feed, viewerId);
}

export async function listFeedPage(
  cursor: number | null | undefined,
  limit: number,
  viewerId?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const feed = await db
    .select({ post: posts, author: users })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(cursor ? lt(posts.id, cursor) : undefined)
    .orderBy(desc(posts.id))
    .limit(limit + 1);
  const hasMore = feed.length > limit;
  const items = await enrichPosts(feed.slice(0, limit), viewerId);
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export async function listMemberPosts(username: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const feed = await db
    .select({ post: posts, author: users })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(
      and(eq(users.username, username), eq(posts.audienceIdentity, "member"))
    )
    .orderBy(desc(posts.createdAt));
  return enrichPosts(feed);
}

export async function listMemberPostsPage(
  username: string,
  cursor: number | null | undefined,
  limit: number,
  viewerId?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const filter = cursor
    ? and(
        eq(users.username, username),
        eq(posts.audienceIdentity, "member"),
        lt(posts.id, cursor)
      )
    : and(eq(users.username, username), eq(posts.audienceIdentity, "member"));
  const feed = await db
    .select({ post: posts, author: users })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(filter)
    .orderBy(desc(posts.id))
    .limit(limit + 1);
  const hasMore = feed.length > limit;
  const items = await enrichPosts(feed.slice(0, limit), viewerId);
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export async function getPost(postId: number, viewerId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select({ post: posts, author: users })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(eq(posts.id, postId))
    .limit(1);
  const item = result[0];
  if (!item) return null;
  const [enriched] = await enrichPosts([item], viewerId);
  return enriched ?? null;
}

export async function updatePost(
  postId: number,
  authorId: number,
  body: string,
  visibility?: "public" | "connections" | "private"
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const existing = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.authorId, authorId)))
    .limit(1);
  if (!existing.length) return null;
  await db
    .update(posts)
    .set({ body, ...(visibility ? { visibility } : {}) })
    .where(eq(posts.id, postId));
  return getPost(postId, authorId);
}

export async function deletePost(postId: number, authorId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const existing = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.authorId, authorId)))
    .limit(1);
  if (!existing.length) return false;
  await db.delete(posts).where(eq(posts.id, postId));
  return true;
}

export async function togglePostLike(postId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const existing = await db
    .select()
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.userId, userId)))
    .limit(1);
  if (existing.length) {
    await db
      .delete(likes)
      .where(and(eq(likes.postId, postId), eq(likes.userId, userId)));
    return false;
  }
  await db.insert(likes).values({ postId, userId });
  return true;
}

export async function addComment(
  postId: number,
  authorId: number,
  body: string,
  gifUrl?: string | null
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .insert(comments)
    .values({ postId, authorId, body, gifUrl: gifUrl || null });
  return Number(result[0].insertId);
}

export async function listPostComments(postId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select({ comment: comments, author: users })
    .from(comments)
    .innerJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.postId, postId))
    .orderBy(comments.createdAt);
  return rows.map(({ comment, author }) => ({
    ...comment,
    author: toPublicMember(author),
  }));
}

export async function createPersona(
  ownerId: number,
  input: {
    name: string;
    username: string;
    avatarUrl: string | null;
    bannerUrl?: string | null;
    bio?: string | null;
    isPublic?: boolean;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db.insert(personas).values({ ownerId, ...input });
  return Number(result[0].insertId);
}

export async function listPersonas(ownerId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  return db
    .select()
    .from(personas)
    .where(eq(personas.ownerId, ownerId))
    .orderBy(desc(personas.id));
}

export async function getPersonaForOwner(personaId: number, ownerId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select()
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.ownerId, ownerId)))
    .limit(1);
  return result[0] ?? null;
}

export async function getPersonaByUsername(username: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select()
    .from(personas)
    .where(eq(personas.username, username))
    .limit(1);
  return result[0] ?? null;
}

export async function getPublicPersonaByUsername(username: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .select({
      id: personas.id,
      name: personas.name,
      username: personas.username,
      avatarUrl: personas.avatarUrl,
      bannerUrl: personas.bannerUrl,
      backgroundImage: personas.backgroundImage,
      bio: personas.bio,
      createdAt: personas.createdAt,
    })
    .from(personas)
    .where(and(eq(personas.username, username), eq(personas.isPublic, true)))
    .limit(1);
  return result[0] ?? null;
}

export async function updatePersonaVisibility(
  personaId: number,
  ownerId: number,
  isPublic: boolean
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  await db
    .update(personas)
    .set({ isPublic })
    .where(and(eq(personas.id, personaId), eq(personas.ownerId, ownerId)));
  return getPersonaForOwner(personaId, ownerId);
}

export async function updatePersonaProfile(
  personaId: number,
  ownerId: number,
  input: {
    name: string;
    username: string;
    avatarUrl: string | null;
    bannerUrl: string | null;
    backgroundImage?: string | null;
    bio: string | null;
    isPublic: boolean;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  await db
    .update(personas)
    .set(input)
    .where(and(eq(personas.id, personaId), eq(personas.ownerId, ownerId)));
  return getPersonaForOwner(personaId, ownerId);
}

export async function searchPublicProfiles(query: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const pattern = `%${query}%`;
  const [members, publicPersonas] = await Promise.all([
    db
      .select()
      .from(users)
      .where(like(users.username, pattern))
      .orderBy(desc(users.lastSignedIn))
      .limit(8),
    db
      .select({
        id: personas.id,
        name: personas.name,
        username: personas.username,
        avatarUrl: personas.avatarUrl,
        bio: personas.bio,
      })
      .from(personas)
      .where(and(eq(personas.isPublic, true), like(personas.username, pattern)))
      .orderBy(desc(personas.id))
      .limit(8),
  ]);
  return {
    members: members.filter(hasPublicUsername).map(toPublicMember),
    personas: publicPersonas,
  };
}

export async function listPersonaPostsPage(
  personaId: number,
  cursor: number | null | undefined,
  limit: number,
  viewerId?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const filter = cursor
    ? and(
        eq(posts.personaId, personaId),
        eq(posts.audienceIdentity, "persona"),
        lt(posts.id, cursor)
      )
    : and(
        eq(posts.personaId, personaId),
        eq(posts.audienceIdentity, "persona")
      );
  const feed = await db
    .select({ post: posts, author: users })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(filter)
    .orderBy(desc(posts.id))
    .limit(limit + 1);
  const hasMore = feed.length > limit;
  const items = await enrichPosts(feed.slice(0, limit), viewerId);
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export async function createNotification(input: {
  recipientId: number;
  senderId: number;
  type: "poke" | "note" | "like" | "comment" | "connection";
  body?: string | null;
  isAnonymous?: "yes" | "no";
  postId?: number | null;
  levelUpLevel?: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .insert(notifications)
    .values({
      ...input,
      body: input.body || null,
      postId: input.postId || null,
      isAnonymous: input.isAnonymous || "no",
    });
  return Number(result[0].insertId);
}

export async function listUnreadNotifications(recipientId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select({ notice: notifications, sender: users })
    .from(notifications)
    .leftJoin(users, eq(notifications.senderId, users.id))
    .where(eq(notifications.recipientId, recipientId))
    .orderBy(desc(notifications.id))
    .limit(30);
  return rows
    .filter(row => !row.notice.readAt)
    .map(({ notice, sender }) => ({
      ...notice,
      sender: sender ? toPublicMember(sender) : null,
    }));
}

export async function listNotifications(recipientId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select({ notice: notifications, sender: users })
    .from(notifications)
    .leftJoin(users, eq(notifications.senderId, users.id))
    .where(eq(notifications.recipientId, recipientId))
    .orderBy(desc(notifications.id))
    .limit(60);
  return rows.map(({ notice, sender }) => ({
    ...notice,
    sender: sender ? toPublicMember(sender) : null,
  }));
}

export async function markNotificationRead(
  notificationId: number,
  recipientId: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const current = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientId, recipientId)
      )
    )
    .limit(1);
  if (current[0]?.type === "connection" && current[0].body?.includes("quer"))
    return;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientId, recipientId)
      )
    );
}

export async function listCommunityMembers() {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const members = (
    await db.select().from(users).orderBy(desc(users.createdAt)).limit(40)
  ).filter(hasPublicUsername);
  return {
    newest: members.slice(0, 5).map(toPublicMember),
    online: members
      .filter(member => member.profileStatus !== "offline")
      .slice(0, 6)
      .map(toPublicMember),
  };
}

export async function getPostOwnerId(postId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select({ authorId: posts.authorId })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return rows[0]?.authorId ?? null;
}
export async function getConnectionBetween(firstId: number, secondId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select()
    .from(connections)
    .where(
      or(
        and(
          eq(connections.requesterId, firstId),
          eq(connections.recipientId, secondId)
        ),
        and(
          eq(connections.requesterId, secondId),
          eq(connections.recipientId, firstId)
        )
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
export async function requestConnection(requesterId: number, username: string) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const recipient = await getMemberByUsername(username);
  if (!recipient || recipient.id === requesterId) return null;
  const existing = await getConnectionBetween(requesterId, recipient.id);
  if (existing?.status === "accepted")
    return { recipient, status: "accepted" as const, created: false };
  if (existing && existing.recipientId === requesterId) {
    await db
      .update(connections)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(connections.id, existing.id));
    return { recipient, status: "accepted" as const, created: false };
  }
  if (existing)
    return { recipient, status: "pending" as const, created: false };
  await db
    .insert(connections)
    .values({ requesterId, recipientId: recipient.id });
  return { recipient, status: "pending" as const, created: true };
}
export async function acceptConnection(
  recipientId: number,
  requesterId: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const acceptedAt = new Date();
  await db
    .update(connections)
    .set({ status: "accepted", acceptedAt })
    .where(
      and(
        eq(connections.requesterId, requesterId),
        eq(connections.recipientId, recipientId),
        eq(connections.status, "pending")
      )
    );
  await db
    .update(notifications)
    .set({ readAt: acceptedAt })
    .where(
      and(
        eq(notifications.recipientId, recipientId),
        eq(notifications.senderId, requesterId),
        eq(notifications.type, "connection"),
        like(notifications.body, "%quer%")
      )
    );
  return getConnectionBetween(recipientId, requesterId);
}
export async function removeConnection(userId: number, otherId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  await db
    .delete(connections)
    .where(
      or(
        and(
          eq(connections.requesterId, userId),
          eq(connections.recipientId, otherId)
        ),
        and(
          eq(connections.requesterId, otherId),
          eq(connections.recipientId, userId)
        )
      )
    );
}
export async function listProfilePlaylists(ownerId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const lists = await db
    .select()
    .from(profilePlaylists)
    .where(eq(profilePlaylists.ownerId, ownerId))
    .orderBy(desc(profilePlaylists.id));
  const ids = lists.map(list => list.id);
  const tracks = ids.length
    ? await db
        .select({ track: playlistTracks, addedBy: users })
        .from(playlistTracks)
        .innerJoin(users, eq(playlistTracks.addedById, users.id))
        .where(inArray(playlistTracks.playlistId, ids))
        .orderBy(desc(playlistTracks.id))
    : [];
  return lists.map(list => ({
    ...list,
    tracks: tracks
      .filter(item => item.track.playlistId === list.id)
      .map(item => ({ ...item.track, addedBy: toPublicMember(item.addedBy) })),
  }));
}
export async function createProfilePlaylist(
  ownerId: number,
  input: {
    title: string;
    thumbnailUrl: string | null;
    theme: "briar" | "midnight" | "holographic" | "ice" | "custom";
    accentColor: string;
    surfaceColor: string;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const result = await db
    .insert(profilePlaylists)
    .values({ ownerId, ...input });
  return Number(result[0].insertId);
}
export async function updateProfilePlaylist(
  playlistId: number,
  ownerId: number,
  input: {
    title: string;
    thumbnailUrl: string | null;
    theme: "briar" | "midnight" | "holographic" | "ice" | "custom";
    accentColor: string;
    surfaceColor: string;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const current = await db
    .select()
    .from(profilePlaylists)
    .where(
      and(
        eq(profilePlaylists.id, playlistId),
        eq(profilePlaylists.ownerId, ownerId)
      )
    )
    .limit(1);
  if (!current[0]) return null;
  await db
    .update(profilePlaylists)
    .set(input)
    .where(eq(profilePlaylists.id, playlistId));
  return { ...current[0], ...input };
}
export async function removeProfilePlaylist(
  playlistId: number,
  ownerId: number
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");

  return db.transaction(async tx => {
    const current = await tx
      .select({ id: profilePlaylists.id })
      .from(profilePlaylists)
      .where(
        and(
          eq(profilePlaylists.id, playlistId),
          eq(profilePlaylists.ownerId, ownerId)
        )
      )
      .limit(1);

    if (!current[0]) return false;

    await tx
      .delete(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId));
    await tx
      .delete(profilePlaylists)
      .where(
        and(
          eq(profilePlaylists.id, playlistId),
          eq(profilePlaylists.ownerId, ownerId)
        )
      );

    return true;
  });
}

export async function addPlaylistTrack(
  playlistId: number,
  addedById: number,
  youtubeUrl: string,
  title: string
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const lists = await db
    .select()
    .from(profilePlaylists)
    .where(eq(profilePlaylists.id, playlistId))
    .limit(1);
  if (!lists[0]) return null;
  const connection =
    lists[0].ownerId === addedById
      ? { status: "accepted" }
      : await getConnectionBetween(lists[0].ownerId, addedById);
  if (connection?.status !== "accepted") return null;
  const result = await db
    .insert(playlistTracks)
    .values({ playlistId, addedById, youtubeUrl, title });
  return Number(result[0].insertId);
}
export async function updatePlaylistTrack(
  trackId: number,
  actorId: number,
  title: string,
  youtubeUrl: string
) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select({ track: playlistTracks, playlist: profilePlaylists })
    .from(playlistTracks)
    .innerJoin(
      profilePlaylists,
      eq(playlistTracks.playlistId, profilePlaylists.id)
    )
    .where(eq(playlistTracks.id, trackId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    (row.track.addedById !== actorId && row.playlist.ownerId !== actorId)
  )
    return null;
  await db
    .update(playlistTracks)
    .set({ title, youtubeUrl })
    .where(eq(playlistTracks.id, trackId));
  return { ...row.track, title, youtubeUrl };
}
export async function removePlaylistTrack(trackId: number, actorId: number) {
  const db = await getDb();
  if (!db) throw new Error("Banco de dados indisponível");
  const rows = await db
    .select({ track: playlistTracks, playlist: profilePlaylists })
    .from(playlistTracks)
    .innerJoin(
      profilePlaylists,
      eq(playlistTracks.playlistId, profilePlaylists.id)
    )
    .where(eq(playlistTracks.id, trackId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    (row.track.addedById !== actorId && row.playlist.ownerId !== actorId)
  )
    return false;
  await db.delete(playlistTracks).where(eq(playlistTracks.id, trackId));
  return true;
}
