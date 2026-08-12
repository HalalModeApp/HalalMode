/**
 * The Terms and Privacy Notice, in the words the app can actually stand behind.
 *
 * These describe what the code really does — what is stored, who can see it,
 * and what is never shown to anyone. They are written from the system rather
 * than from a template, which is the part a lawyer cannot do for us. Have a
 * lawyer review the wording before public launch; the facts here are correct,
 * the legal framing is not a substitute for advice.
 *
 * The versions must match `legal_document_registry` in the database, because
 * that is what members' acceptance is recorded against.
 */

export const LEGAL_VERSION = '2026-07-29';

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDocument {
  slug: 'terms' | 'privacy';
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const TERMS: LegalDocument = {
  slug: 'terms',
  title: 'Terms of Service',
  updated: LEGAL_VERSION,
  intro:
    'Halal Mode introduces a small number of people to each other each day, for the purpose of marriage. These terms explain what we promise you, and what we ask of you in return.',
  sections: [
    {
      heading: 'Who can use Halal Mode',
      body: [
        'You must be 18 or older.',
        'You must be genuinely seeking marriage, and free to marry.',
        'One person, one account. Do not create an account for someone else, or pretend to be someone you are not.',
      ],
    },
    {
      heading: 'How introductions work',
      body: [
        'Each day you are shown a small set of people. Free members see five and may keep one; Premium members see ten and may keep three.',
        'Introductions are mutual. If someone appears in your set, you appear in theirs. Nobody is browsed without appearing themselves.',
        'Interest is private. If you choose someone and they do not choose you, they are never told. You will never be told that someone chose you unless you chose them back.',
        'We do not guarantee that you will be matched, or how many introductions you will receive on any given day. That depends on how many suitable people are available.',
      ],
    },
    {
      heading: 'What we ask of you',
      body: [
        'Be honest about who you are and what you are looking for.',
        'Treat everyone with respect, in every message.',
        'Do not harass, threaten, deceive, or pressure anyone.',
        'Do not share anyone else’s photographs, messages, or details outside the app.',
        'Do not use Halal Mode to advertise, recruit, or sell.',
      ],
    },
    {
      heading: 'Safety',
      body: [
        'You can block or report anyone you have been introduced to. Blocking is immediate and the other person is not told.',
        'We may suspend or remove an account that breaks these terms or puts other members at risk. Where we can, we will tell you why.',
        'Halal Mode is an introduction service. We do not verify identity, background, or intentions, and we cannot guarantee anyone’s honesty. Take the same care you would take meeting anyone new. Meet in public, tell someone where you are going, and involve your family as you see fit.',
      ],
    },
    {
      heading: 'Your account',
      body: [
        'You can pause your profile or close your account at any time, from Settings.',
        'Closing your account removes your profile, photos, preferences, and messages. Some records are kept where the law requires it, or where they are needed to keep other members safe — for example a record that a report was made.',
      ],
    },
    {
      heading: 'Payment',
      body: [
        'Halal Mode Premium is an optional paid membership. Prices are shown before you pay.',
        'Payment is handled by the app store you bought it from, and their refund rules apply. You can cancel a subscription from your app store account.',
        'Premium changes how many introductions you receive. It does not buy anyone’s attention, and it does not make anyone more likely to choose you.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'If we change these terms in a way that matters, we will ask you to read and accept them again before you continue.',
      ],
    },
    {
      heading: 'Getting in touch',
      body: ['Write to us at hello@halalmo.de and a person will read it.'],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy Notice',
  updated: LEGAL_VERSION,
  intro:
    'This explains exactly what Halal Mode stores, who can see it, and what is never shown to anyone. It is written to be read, not to be skipped.',
  sections: [
    {
      heading: 'What we store',
      body: [
        'Your email address, so you can sign in.',
        'Your profile: name, date of birth, city and country, what you do, what you have written about yourself, your photographs, and an optional voice introduction.',
        'Your preferences: the age, distance, and other qualities you are looking for, and which of them are must-haves.',
        'Your activity: which introductions you were shown, which you kept, your answers to the questions, and your messages.',
        'Rough coordinates for your city, used only to work out how far apart two people are.',
      ],
    },
    {
      heading: 'What other members see',
      body: [
        'People you are introduced to see your first name, age, city, occupation, what you have written, your photographs, and your voice introduction if you recorded one.',
        'They never see your email address, your date of birth, your exact location, or your preferences.',
        'They are never told that you were shown their profile and did not choose them.',
      ],
    },
    {
      heading: 'What nobody sees',
      body: [
        'We keep a private score used to decide who to introduce to whom. It is never shown to anyone — including you. It is not a rating of you as a person, and it is not shared.',
        'Your answers to a question are released to the other person only once they have answered the same question themselves. Until then, they cannot see it.',
        'Blocks and reports are private. The person you blocked or reported is not told.',
        'Your exact location is never stored. Only a rough position for your city, and only to measure distance.',
      ],
    },
    {
      heading: 'Your messages',
      body: [
        'Messages are stored so they are there when you come back, and so they can be shown to you on another device.',
        'We do not read your messages. The exception is a safety investigation after a report, where a small number of trained staff may read what is necessary to make a decision — and nothing more.',
        'Messages are removed when the account is closed.',
      ],
    },
    {
      heading: 'Your photographs',
      body: [
        'Photographs and voice recordings are stored privately. They are never publicly accessible, and are served only to people you have been introduced to, through links that expire.',
      ],
    },
    {
      heading: 'Who we share with',
      body: [
        'We do not sell your data. We never have and we will not.',
        'We use suppliers to run the service — hosting, database, email delivery, and app store payments. They process data on our instructions and may not use it for anything else.',
        'We will share information if the law requires it, or to protect someone from serious harm.',
      ],
    },
    {
      heading: 'Your choices',
      body: [
        'You can change or delete anything on your profile at any time.',
        'You can pause your profile, which stops new introductions without deleting anything.',
        'You can close your account, which removes your profile, photographs, preferences, and messages.',
        'You can ask for a copy of your data, or ask us to correct it. Write to hello@halalmo.de.',
      ],
    },
    {
      heading: 'How long we keep things',
      body: [
        'While your account is open, we keep your profile and messages so the service works.',
        'When you close your account, we remove them. We keep a minimal record where the law requires it, or where it is needed to keep other members safe.',
      ],
    },
    {
      heading: 'Getting in touch',
      body: [
        'Write to hello@halalmo.de with any question about your data, and a person will answer.',
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: Record<'terms' | 'privacy', LegalDocument> = {
  terms: TERMS,
  privacy: PRIVACY,
};
