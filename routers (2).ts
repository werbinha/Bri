import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "./db";
import {
  addCommentInputSchema,
  addPlaylistTrackInputSchema,
  connectionTargetSchema,
  connectionUserSchema,
  createPersonaInputSchema,
  createPlaylistInputSchema,
  createPostInputSchema,
  loginInputSchema,
  memberPostsInputSchema,
  notificationIdInputSchema,
  paginatedFeedInputSchema,
  paginatedMemberPostsInputSchema,
  personaVisibilityInputSchema,
  postIdInputSchema,
  profileInputSchema,
  profileSearchInputSchema,
  recipientInputSchema,
  registerInputSchema,
  removePlaylistTrackInputSchema,
  sendNoteInputSchema,
  updatePersonaInputSchema,
  updatePlaylistInputSchema,
  updatePlaylistTrackInputSchema,
  updatePostInputSchema,
  usernameSchema,
} from "./inputSchemas";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { POKE_RECEIVED_XP, POST_XP } from "./progression";
import {
  clearLocalSession,
  createSessionToken,
  getSessionExpiry,
  hashPassword,
  hashSessionToken,
  LOCAL_SESSION_COOKIE,
  readLocalSessionToken,
  setLocalSession,
  verifyPassword,
} from "./localAuth";
import { storageCreateUploadUrl, storagePut } from "./storage";

async function getLocalMember(cookieHeader: string | undefined) {
  const token = readLocalSessionToken(cookieHeader);
  if (!token) return null;
  return db.getMemberBySessionHash(hashSessionToken(token));
}

async function requireLocalMember(cookieHeader: string | undefined) {
  const member = await getLocalMember(cookieHeader);
  if (!member)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Entre na sua conta Briar para continuar.",
    });
  return member;
}

function toCurrentMember(
  member: typeof db.toSessionMember extends (member: infer T) => unknown
    ? T
    : never
) {
  return db.toSessionMember(member);
}

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(async ({ ctx }) => {
      const member = await getLocalMember(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      return member ? toCurrentMember(member) : null;
    }),
    register: publicProcedure
      .input(registerInputSchema)
      .mutation(async ({ input, ctx }) => {
        const existing =
          (await db.findMemberByEmailOrUsername(input.email)) ??
          (await db.getMemberByUsername(input.username));
        if (existing)
          throw new TRPCError({
            code: "CONFLICT",
            message: "E-mail ou @username já está em uso.",
          });
        const member = await db.createLocalMember({
          ...input,
          passwordHash: await hashPassword(input.password),
        });
        const token = createSessionToken();
        await db.createMemberSession(
          member.id,
          hashSessionToken(token),
          getSessionExpiry()
        );
        setLocalSession(ctx.res, ctx.req, token);
        return toCurrentMember(member);
      }),
    login: publicProcedure
      .input(loginInputSchema)
      .mutation(async ({ input, ctx }) => {
        const identifier = input.identifier.toLowerCase().replace(/^@/, "");
        const member = await db.findMemberByEmailOrUsername(identifier);
        if (
          !member ||
          !(await verifyPassword(input.password, member.passwordHash))
        ) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Dados de acesso inválidos.",
          });
        }
        const token = createSessionToken();
        await db.createMemberSession(
          member.id,
          hashSessionToken(token),
          getSessionExpiry()
        );
        setLocalSession(ctx.res, ctx.req, token);
        return toCurrentMember(member);
      }),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      const rawToken = readLocalSessionToken(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      if (rawToken) await db.clearMemberSession(hashSessionToken(rawToken));
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      clearLocalSession(ctx.res, ctx.req);
      return {
        success: true,
      } as const;
    }),
  }),
  media: router({
    createUploadUrl: publicProcedure
      .input(
        z.object({
          filename: z.string().trim().min(1).max(100),
          contentType: z.enum([
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "video/mp4",
            "video/webm",
          ]),
          byteSize: z
            .number()
            .int()
            .positive()
            .max(200 * 1024 * 1024),
          scope: z.enum([
            "avatar",
            "banner",
            "post",
            "profile-background",
            "highlight",
            "comment",
            "jukebox-thumbnail",
          ]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        if (
          input.scope === "comment" &&
          (input.contentType !== "image/gif" ||
            input.byteSize > 100 * 1024 * 1024)
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Comentários aceitam GIFs de até 100 MB.",
          });
        const extensionByType = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
          "video/mp4": "mp4",
          "video/webm": "webm",
        } as const;
        const intent = await storageCreateUploadUrl(
          `briar/${member.id}/${input.scope}-${Date.now()}.${extensionByType[input.contentType]}`
        );
        return {
          ...intent,
          uploadUrl: `/api/media-upload?key=${encodeURIComponent(intent.key)}`,
        };
      }),
    uploadImage: publicProcedure
      .input(
        z.object({
          dataUrl: z.string().min(20).max(6_500_000),
          filename: z.string().trim().min(1).max(100),
          scope: z.enum([
            "avatar",
            "banner",
            "post",
            "profile-background",
            "highlight",
            "comment",
            "jukebox-thumbnail",
          ]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const match = input.dataUrl.match(
          /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/
        );
        if (!match)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Envie uma imagem PNG, JPG, WEBP ou GIF válida.",
          });
        const data = Buffer.from(match[2], "base64");
        if (data.length > 4_500_000)
          throw new TRPCError({
            code: "PAYLOAD_TOO_LARGE",
            message: "A imagem deve ter no máximo 4,5 MB.",
          });
        const extension = match[1].split("/")[1].replace("jpeg", "jpg");
        const upload = await storagePut(
          `briar/${member.id}/${input.scope}-${Date.now()}.${extension}`,
          data,
          match[1]
        );
        return upload;
      }),
  }),
  profile: router({
    me: publicProcedure.query(async ({ ctx }) => {
      const member = await requireLocalMember(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      return toCurrentMember(member);
    }),
    get: publicProcedure
      .input(z.object({ username: usernameSchema }))
      .query(async ({ input }) => {
        const member = await db.getMemberByUsername(input.username);
        if (!member)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Perfil não encontrado.",
          });
        return db.toPublicMember(member);
      }),
    update: publicProcedure
      .input(profileInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        if (input.username !== member.username) {
          const owner = await db.getMemberByUsername(input.username);
          if (owner && owner.id !== member.id) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Esse @username já está em uso.",
            });
          }
        }
        const updated = await db.updateMemberProfile(member.id, {
          ...input,
          profileTags: JSON.stringify(input.profileTags),
          profileHighlights: JSON.stringify(input.profileHighlights),
        });
        return toCurrentMember(updated);
      }),
  }),
  personas: router({
    list: publicProcedure.query(async ({ ctx }) => {
      const member = await requireLocalMember(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      return db.listPersonas(member.id);
    }),
    create: publicProcedure
      .input(createPersonaInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        if (await db.getPersonaByUsername(input.username))
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esse @usuário de persona já está em uso.",
          });
        return { id: await db.createPersona(member.id, input) };
      }),
    update: publicProcedure
      .input(updatePersonaInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const current = await db.getPersonaForOwner(input.personaId, member.id);
        if (!current)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você só pode editar suas próprias personas.",
          });
        if (
          input.username !== current.username &&
          (await db.getPersonaByUsername(input.username))
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "Esse @usuário de persona já está em uso.",
          });
        const { personaId, ...profile } = input;
        return db.updatePersonaProfile(personaId, member.id, profile);
      }),
    setVisibility: publicProcedure
      .input(personaVisibilityInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const persona = await db.updatePersonaVisibility(
          input.personaId,
          member.id,
          input.isPublic
        );
        if (!persona)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você só pode editar suas próprias personas.",
          });
        return persona;
      }),
    publicProfile: publicProcedure
      .input(z.object({ username: usernameSchema }))
      .query(async ({ input }) => {
        const persona = await db.getPublicPersonaByUsername(input.username);
        if (!persona)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Perfil de persona não encontrado ou privado.",
          });
        return persona;
      }),
    publicPostsPage: publicProcedure
      .input(paginatedFeedInputSchema.extend({ username: usernameSchema }))
      .query(async ({ input, ctx }) => {
        const persona = await db.getPublicPersonaByUsername(input.username);
        if (!persona)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Perfil de persona não encontrado ou privado.",
          });
        const member = await getLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        return db.listPersonaPostsPage(
          persona.id,
          input.cursor,
          input.limit,
          member?.id
        );
      }),
  }),
  notifications: router({
    list: publicProcedure.query(async ({ ctx }) => {
      const member = await requireLocalMember(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      return db.listNotifications(member.id);
    }),
    unread: publicProcedure.query(async ({ ctx }) => {
      const member = await requireLocalMember(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      return db.listUnreadNotifications(member.id);
    }),
    dismiss: publicProcedure
      .input(notificationIdInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        await db.markNotificationRead(input.notificationId, member.id);
        return { success: true } as const;
      }),
    poke: publicProcedure
      .input(recipientInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const recipient = await db.getMemberByUsername(input.username);
        if (!recipient)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Perfil não encontrado.",
          });
        if (recipient.id === member.id)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Você não pode se cutucar.",
          });
        const id = await db.createNotification({
            recipientId: recipient.id,
            senderId: member.id,
            type: "poke",
          });
        const progression = await db.addMemberXp(recipient.id, POKE_RECEIVED_XP);
        if (progression?.leveledUp)
          await db.createNotification({ recipientId: recipient.id, senderId: recipient.id, type: "note", levelUpLevel: progression.level, body: `Você alcançou o nível ${progression.level}!` });
        return { id, progression: progression ? { level: progression.level, leveledUp: progression.leveledUp } : null };
      }),
    sendNote: publicProcedure
      .input(sendNoteInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const recipient = await db.getMemberByUsername(input.username);
        if (!recipient)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Perfil não encontrado.",
          });
        if (recipient.id === member.id)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Você não pode enviar um recado para si mesma.",
          });
        return {
          id: await db.createNotification({
            recipientId: recipient.id,
            senderId: member.id,
            type: "note",
            body: input.body,
            isAnonymous: input.isAnonymous ? "yes" : "no",
          }),
        };
      }),
  }),
  connections: router({
    status: publicProcedure
      .input(connectionTargetSchema)
      .query(async ({ input, ctx }) => {
        const viewer = await getLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const target = await db.getMemberByUsername(input.username);
        return viewer && target
          ? db.getConnectionBetween(viewer.id, target.id)
          : null;
      }),
    request: publicProcedure
      .input(connectionTargetSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const result = await db.requestConnection(member.id, input.username);
        if (!result)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Não foi possível conectar este perfil.",
          });
        if (result.created)
          await db.createNotification({
            recipientId: result.recipient.id,
            senderId: member.id,
            type: "connection",
            body: "quer se conectar com você.",
          });
        return result;
      }),
    accept: publicProcedure
      .input(connectionUserSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const connection = await db.acceptConnection(member.id, input.userId);
        if (!connection || connection.status !== "accepted")
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Pedido de conexão não encontrado.",
          });
        await db.createNotification({
          recipientId: input.userId,
          senderId: member.id,
          type: "connection",
          body: "aceitou sua conexão.",
        });
        return connection;
      }),
    remove: publicProcedure
      .input(connectionUserSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        await db.removeConnection(member.id, input.userId);
        return { success: true } as const;
      }),
  }),
  jukebox: router({
    list: publicProcedure
      .input(z.object({ username: usernameSchema }))
      .query(async ({ input }) => {
        const owner = await db.getMemberByUsername(input.username);
        if (!owner)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Perfil não encontrado.",
          });
        return db.listProfilePlaylists(owner.id);
      }),
    create: publicProcedure
      .input(createPlaylistInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        return { id: await db.createProfilePlaylist(member.id, input) };
      }),
    update: publicProcedure
      .input(updatePlaylistInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const { playlistId, ...playlist } = input;
        const updated = await db.updateProfilePlaylist(
          playlistId,
          member.id,
          playlist
        );
        if (!updated)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você só pode personalizar as suas playlists.",
          });
        return updated;
      }),
    addTrack: publicProcedure
      .input(addPlaylistTrackInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const id = await db.addPlaylistTrack(
          input.playlistId,
          member.id,
          input.youtubeUrl,
          input.title
        );
        if (!id)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Apenas conexões podem adicionar músicas a esta jukebox.",
          });
        return { id };
      }),
    updateTrack: publicProcedure
      .input(updatePlaylistTrackInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const track = await db.updatePlaylistTrack(
          input.id,
          member.id,
          input.title,
          input.youtubeUrl
        );
        if (!track)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você não pode editar esta faixa.",
          });
        return track;
      }),
    removeTrack: publicProcedure
      .input(removePlaylistTrackInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const removed = await db.removePlaylistTrack(input.trackId, member.id);
        if (!removed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você não pode remover esta faixa.",
          });
        return { success: true } as const;
      }),
    remove: publicProcedure
      .input(z.object({ playlistId: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const removed = await db.removeProfilePlaylist(
          input.playlistId,
          member.id
        );
        if (!removed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você só pode remover suas próprias playlists.",
          });
        return { success: true } as const;
      }),
  }),
  social: router({
    searchProfiles: publicProcedure
      .input(profileSearchInputSchema)
      .query(({ input }) => db.searchPublicProfiles(input.query)),
    feed: publicProcedure.query(async ({ ctx }) => {
      const member = await getLocalMember(
        typeof ctx.req.headers.cookie === "string"
          ? ctx.req.headers.cookie
          : undefined
      );
      return db.listFeed(member?.id);
    }),
    feedPage: publicProcedure
      .input(paginatedFeedInputSchema)
      .query(async ({ input, ctx }) => {
        const member = await getLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        return db.listFeedPage(input.cursor, input.limit, member?.id);
      }),
    post: publicProcedure
      .input(postIdInputSchema)
      .query(async ({ input, ctx }) => {
        const member = await getLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const post = await db.getPost(input.postId, member?.id);
        if (!post)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Publicação não encontrada.",
          });
        return post;
      }),
    createPost: publicProcedure
      .input(createPostInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        let personaId: number | null = null;
        if (input.audienceIdentity === "persona") {
          if (!input.personaId)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Selecione uma persona para publicar.",
            });
          if (!(await db.getPersonaForOwner(input.personaId, member.id)))
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Essa persona não pertence à sua conta.",
            });
          personaId = input.personaId;
        }
        const id = await db.createPost(
            member.id,
            input.body,
            input.imageUrl,
            input.mediaType || "image",
            personaId,
            input.audienceIdentity,
            input.visibility
          );
        const progression = await db.addMemberXp(member.id, POST_XP);
        if (progression?.leveledUp)
          await db.createNotification({ recipientId: member.id, senderId: member.id, type: "note", levelUpLevel: progression.level, body: `Você alcançou o nível ${progression.level}!` });
        return { id, progression: progression ? { level: progression.level, leveledUp: progression.leveledUp } : null };
      }),
    updatePost: publicProcedure
      .input(updatePostInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const post = await db.updatePost(
          input.postId,
          member.id,
          input.body,
          input.visibility
        );
        if (!post)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você só pode editar suas próprias publicações.",
          });
        return post;
      }),
    deletePost: publicProcedure
      .input(postIdInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        const deleted = await db.deletePost(input.postId, member.id);
        if (!deleted)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Você só pode excluir suas próprias publicações.",
          });
        return { success: true } as const;
      }),
    toggleLike: publicProcedure
      .input(postIdInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        if (!(await db.viewerCanAccessPost(input.postId, member.id)))
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Esta publicação é reservada.",
          });
        const liked = await db.togglePostLike(input.postId, member.id);
        const ownerId = await db.getPostOwnerId(input.postId);
        if (liked && ownerId && ownerId !== member.id)
          await db.createNotification({
            recipientId: ownerId,
            senderId: member.id,
            type: "like",
            postId: input.postId,
            body: "curtiu sua publicação.",
          });
        return { liked };
      }),
    comments: publicProcedure
      .input(postIdInputSchema)
      .query(async ({ input, ctx }) => {
        const member = await getLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        if (!(await db.viewerCanAccessPost(input.postId, member?.id)))
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Esta publicação é reservada.",
          });
        return db.listPostComments(input.postId);
      }),
    memberPosts: publicProcedure
      .input(memberPostsInputSchema)
      .query(({ input }) => db.listMemberPosts(input.username)),
    memberPostsPage: publicProcedure
      .input(paginatedMemberPostsInputSchema)
      .query(async ({ input, ctx }) => {
        const member = await getLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        return db.listMemberPostsPage(
          input.username,
          input.cursor,
          input.limit,
          member?.id
        );
      }),
    addComment: publicProcedure
      .input(addCommentInputSchema)
      .mutation(async ({ input, ctx }) => {
        const member = await requireLocalMember(
          typeof ctx.req.headers.cookie === "string"
            ? ctx.req.headers.cookie
            : undefined
        );
        if (!(await db.viewerCanAccessPost(input.postId, member.id)))
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Esta publicação é reservada.",
          });
        const id = await db.addComment(
          input.postId,
          member.id,
          input.body,
          input.gifUrl
        );
        const ownerId = await db.getPostOwnerId(input.postId);
        if (ownerId && ownerId !== member.id)
          await db.createNotification({
            recipientId: ownerId,
            senderId: member.id,
            type: "comment",
            postId: input.postId,
            body: input.gifUrl
              ? "comentou com um GIF na sua publicação."
              : "comentou na sua publicação.",
          });
        return { id };
      }),
    community: publicProcedure.query(() => db.listCommunityMembers()),
  }),
});

export type AppRouter = typeof appRouter;
