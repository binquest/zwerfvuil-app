import { describe, expect, it } from '@jest/globals';

import { cleanName, gateFor, nameError, nextGate } from '../onboarding';

const signedIn = { loading: false, signedIn: true, profileLoaded: true };

describe('gateFor (three states once signed in)', () => {
  it('waits on a splash while the session or the profile is unknown', () => {
    expect(gateFor({ loading: true, signedIn: false, profileLoaded: false, profile: null })).toBe('splash');
    expect(gateFor({ ...signedIn, profileLoaded: false, profile: null })).toBe('splash');
  });

  it('shows the login without a session', () => {
    expect(gateFor({ loading: false, signedIn: false, profileLoaded: false, profile: null })).toBe('login');
  });

  it('shows the onboarding until it is done', () => {
    expect(gateFor({ ...signedIn, profile: { onboardedAt: null } })).toBe('onboarding');
    expect(gateFor({ ...signedIn, profile: { onboardedAt: '2026-10-19T10:00:00Z' } })).toBe('app');
  });

  it('opens the app when the profile could not be loaded (offline): never stuck', () => {
    expect(gateFor({ ...signedIn, profile: null })).toBe('app');
  });
});

describe('nextGate', () => {
  it('only switches from the app to the onboarding when nothing is open', () => {
    expect(nextGate('app', 'onboarding', false)).toBe('app');
    expect(nextGate('app', 'onboarding', true)).toBe('onboarding');
  });

  it('follows every other change at once', () => {
    expect(nextGate(null, 'onboarding', false)).toBe('onboarding');
    expect(nextGate('splash', 'onboarding', false)).toBe('onboarding');
    expect(nextGate('onboarding', 'app', false)).toBe('app');
    expect(nextGate('app', 'login', false)).toBe('login');
  });
});

describe('names (the rule of private.clean_name)', () => {
  it('collapses and trims whitespace', () => {
    expect(cleanName('  Alice \t  Peeters ')).toBe('Alice Peeters');
  });

  it('allows 2 to 24 characters', () => {
    expect(nameError('Al')).toBeNull();
    expect(nameError('x'.repeat(24))).toBeNull();
    expect(nameError(' a ')).toBe('Gebruik minstens 2 tekens.');
    expect(nameError('x'.repeat(25))).toBe('Gebruik hoogstens 24 tekens.');
  });

  it('counts characters like the server, not UTF-16 units', () => {
    expect(nameError('🦊'.repeat(24))).toBeNull();
    expect(nameError('🦊')).toBe('Gebruik minstens 2 tekens.');
  });

  it('refuses control characters', () => {
    expect(nameError('Al\u0007ice')).toBe('Gebruik alleen letters, cijfers en leestekens.');
  });
});
