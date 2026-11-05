// ╔════════════════════════════════════════════════════════════════════════════╗
// ║ GOLDEN EXAMPLE — the /add-endpoint skill copies this file's shape.         ║
// ║ Every kit endpoint shows the same six things:                              ║
// ║   1. a permission key (checked by the framework before the handler)        ║
// ║   2. a Zod input schema (validation at the boundary — handlers see types)  ║
// ║   3. notFound() for missing OR denied resources (404-uniformity)           ║
// ║   4. an audit action on every mutation                                     ║
// ║   5. a uniformityFixture on every :param route (tripwire coverage)         ║
// ║   6. `needs` — the repositories it may reach; ctx.db narrows to exactly    ║
// ║      those, and throws on the rest (opt-in, but this is the shape to copy) ║
// ║ Tests live in test/routes/notes.test.ts — copy those alongside.            ║
// ╚════════════════════════════════════════════════════════════════════════════╝
import { z } from 'zod';
import { defineRoute } from '../framework/defineRoute';
import { ok } from '../framework/envelope';
import { notFound } from '../framework/errors';

const noteIdInput = z.object({ id: z.string().min(1) });

export const notesRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/notes',
    permission: 'notes.read',
    needs: ['notes'],
    summary: 'List notes, newest first, with an opaque keyset cursor',
    input: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
    handler: async (ctx, input) => ctx.db.notes.list(input),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/notes',
    permission: 'notes.write',
    needs: ['notes'],
    audit: 'note.create',
    summary: 'Create a note',
    input: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(20_000).default(''),
    }),
    handler: async (ctx, input) => {
      const note = await ctx.db.notes.create({
        title: input.title,
        body: input.body,
        createdBy: ctx.principal.email,
      });
      ctx.setAuditTarget(note.id);
      return ok(note, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/notes/:id',
    permission: 'notes.read',
    needs: ['notes'],
    summary: 'Fetch one note',
    input: noteIdInput,
    uniformityFixture: {
      seed: async (db) => {
        const note = await db.notes.create({
          title: 'Uniformity fixture (synthetic)',
          body: 'synthetic fixture data',
          createdBy: 'fixture@test.example',
        });
        return { id: note.id };
      },
    },
    handler: async (ctx, input) => {
      const note = await ctx.db.notes.get(input.id);
      if (!note) throw notFound();
      return note;
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/notes/:id',
    permission: 'notes.write',
    needs: ['notes'],
    audit: 'note.update',
    summary: 'Update a note (partial: title and/or body)',
    input: noteIdInput.extend({
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(20_000).optional(),
    }),
    uniformityFixture: {
      seed: async (db) => {
        const note = await db.notes.create({
          title: 'Uniformity fixture (synthetic)',
          body: 'synthetic fixture data',
          createdBy: 'fixture@test.example',
        });
        return { id: note.id };
      },
    },
    handler: async (ctx, input) => {
      const updated = await ctx.db.notes.update(input.id, {
        title: input.title,
        body: input.body,
      });
      if (!updated) throw notFound();
      // The framework writes `note.update` with the `:id` path param — no setAuditTarget needed.
      return ctx.db.notes.get(input.id);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/notes/:id',
    permission: 'notes.write',
    needs: ['notes'],
    audit: 'note.delete',
    summary: 'Delete a note',
    input: noteIdInput,
    uniformityFixture: {
      seed: async (db) => {
        const note = await db.notes.create({
          title: 'Uniformity fixture (synthetic)',
          body: 'synthetic fixture data',
          createdBy: 'fixture@test.example',
        });
        return { id: note.id };
      },
    },
    handler: async (ctx, input) => {
      const removed = await ctx.db.notes.remove(input.id);
      if (!removed) throw notFound();
      // The framework writes `note.delete` with the `:id` path param — no setAuditTarget needed.
      return new Response(null, { status: 204 });
    },
  }),
];
