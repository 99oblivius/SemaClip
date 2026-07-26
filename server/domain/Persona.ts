import type { Persona, PersonaState, Axis } from "shared/types";
import { AXES } from "shared/types";

export function defaultPersonaState(): PersonaState {
  const axisWeights = {} as Record<Axis, number>;
  for (const axis of AXES) axisWeights[axis] = 1 / AXES.length;
  return { axisWeights, thresholds: {} };
}

export function createPersona(id: string): Persona {
  return {
    id,
    state: defaultPersonaState(),
    updatedAt: new Date().toISOString(),
    streamCount: 0,
  };
}

export function incrementStreamCount(persona: Persona): Persona {
  return { ...persona, streamCount: persona.streamCount + 1, updatedAt: new Date().toISOString() };
}
