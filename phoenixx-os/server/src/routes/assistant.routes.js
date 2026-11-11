import { Router } from 'express';
import { z } from 'zod';
import { get } from '../db/index.js';
import { ok, validate, forbidden } from '../lib/http.js';
import { DEFAULT_TZ } from '../lib/dueTime.js';
import {
  aiConfigured, canUseAssistant, eligibleAssignees, interpretCommand, matchPerson, AssistantUnavailable, hasTamil,
} from '../services/taskAssistant.js';

/**
 * AI Task Assistant (see services/taskAssistant.js). Two read-only endpoints:
 * who may be assigned, and what a command means.
 *
 * Everyone on the team may use it. Owners and managers hand out work (`assign`):
 * the result is an ordinary POST /action-items, re-checked there. Everyone else
 * (`personal`) has nobody to assign to, so what they say becomes their own to-do
 * through POST /todos; they gain no way to give anyone else work.
 */
const router = Router();

router.use((req, res, next) => {
  if (req.auth.role === 'client') throw forbidden('The task assistant is for the team');
  next();
});

const person = (p) => ({ id: p.id, name: p.name, designation: p.designation, avatar_url: p.avatar_url });

/** The people this caller may hand a task to, whether AI interpretation is on, and which mode they are in. */
router.get('/task/people', async (req, res) => ok(res, {
  people: (await eligibleAssignees(req.auth)).map(person),
  ai: aiConfigured(),
  mode: canUseAssistant(req.auth) ? 'assign' : 'personal',
}));

router.post('/task/interpret', async (req, res) => {
  const { text } = validate(z.object({ text: z.string().trim().min(3).max(1000) }), req.body);
  const tenant = await get('SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);

  let draft;
  try {
    draft = await interpretCommand(text, { timezone: tenant?.timezone || DEFAULT_TZ });
  } catch (err) {
    if (err instanceof AssistantUnavailable) {
      // The web app has a rule-based parser for exactly this case. It reads
      // English only, so a Tamil command says so instead of guessing.
      return ok(res, { engine: 'none', reason: err.message, tamil: hasTamil(text) });
    }
    throw err;
  }

  const people = await eligibleAssignees(req.auth);
  const matches = draft.assignee_name ? matchPerson(draft.assignee_name, people).map(person) : [];
  return ok(res, {
    engine: 'ai',
    understood: draft.understood,
    clarification: draft.clarification,
    draft: {
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      due_date: draft.due_date,
      due_time: draft.due_time,
    },
    person: {
      heard: draft.assignee_name,
      // 1 -> preselected, 2+ -> the user chooses, 0 -> not found / not named.
      matches,
    },
  });
});

export { router as assistantRouter };
