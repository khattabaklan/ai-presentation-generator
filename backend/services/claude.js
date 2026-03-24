const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

// ─── Humanizer Directive ─────────────────────────────────────────────────────
// Injected into all content-generation prompts so output reads like a real student wrote it.

const HUMANIZER_RULES = `
CRITICAL WRITING RULES — your output must read like a real person wrote it, not AI:

1. NEVER use these words/phrases: additionally, crucial, delve, emphasize, enduring, enhance, foster, garner, highlight, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant, nestled, groundbreaking, renowned, breathtaking, boasts, serves as, stands as, marks a, represents a.
2. Use "is", "are", "has" instead of "serves as", "stands as", "features", "boasts".
3. No -ing filler phrases tacked onto sentences (highlighting, underscoring, emphasizing, reflecting, showcasing, fostering, ensuring, contributing to).
4. No rule-of-three lists forced for rhetorical effect. Two items or four are fine.
5. No "Not only X, but also Y" or "It's not just about X; it's about Y" constructions.
6. No generic positive conclusions ("the future looks bright", "exciting times ahead").
7. No vague attributions ("experts say", "observers note", "industry reports suggest") — be specific or leave it out.
8. No em dash overuse. Use commas or periods instead.
9. No sycophantic openers ("Great question!", "Certainly!", "I hope this helps!").
10. Vary sentence length naturally. Mix short punchy sentences with longer ones. Don't make every sentence the same rhythm.
11. Use first person ("I", "my") where appropriate, especially for reflections. Have opinions. Acknowledge mixed feelings.
12. Be specific, not vague. Concrete details over sweeping claims about significance.
13. Use straight quotes ("...") not curly quotes.
14. Don't bold random phrases or use emojis.
15. Avoid synonym cycling — just use the same word again if it's the right word.
16. Keep headings in sentence case, not Title Case.
17. Write like you're explaining to a smart friend, not performing for a teacher.
`;

async function generatePresentationContent(assignmentText, slideCount = 10, colorTheme = 'professional') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are an expert university presentation creator. Given the following assignment instructions, generate a structured presentation.
${HUMANIZER_RULES}
ASSIGNMENT INSTRUCTIONS:
${assignmentText}

REQUIREMENTS:
- Create exactly ${slideCount} slides
- Color theme preference: ${colorTheme}
- Include a title slide as slide 1
- Include a conclusion/summary slide as the last slide
- Each slide should have clear, concise bullet points (3-5 per slide)
- Generate detailed speaker notes for each slide (2-4 sentences per slide)
- Speaker notes and bullet points MUST follow the writing rules above — sound like a real student, not an AI

Respond with ONLY valid JSON in this exact format:
{
  "title": "Presentation Title",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Slide Title",
      "bullets": ["Bullet point 1", "Bullet point 2", "Bullet point 3"],
      "speakerNotes": "Detailed speaker notes for this slide..."
    }
  ]
}`,
      },
    ],
  });

  const text = response.content[0].text;

  // Extract JSON from the response (handle potential markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse presentation content from Claude response');
  }

  const content = JSON.parse(jsonMatch[0]);

  if (!content.title || !Array.isArray(content.slides) || content.slides.length === 0) {
    throw new Error('Invalid presentation structure returned from Claude');
  }

  return content;
}

// ─── Page Content Parsing (Deep Crawl) ──────────────────────────────────────

const PAGE_PROMPTS = {
  courses: (text) => `You are extracting course information from a Brightspace LMS homepage.

PAGE TEXT:
${text}

Extract ALL courses the student is enrolled in. For each course, extract:
- courseId: the numeric ID from any /d2l/home/{ID} URL
- name: the full course name
- code: the course code if visible (e.g., "CIS 2750", "BIOL-2301")

Respond with ONLY valid JSON:
{"courses": [{"courseId": "12345", "name": "Introduction to Computing", "code": "CIS 1500"}]}

If no courses found, return {"courses": []}.`,

  assignments_list: (text, courseId) => `You are extracting assignments from a Brightspace LMS dropbox/assignments page for course ${courseId}.

PAGE TEXT:
${text}

Extract ALL assignments visible. For each one:
- title: assignment name
- dueDate: due date in ISO 8601 if visible, null otherwise
- points: total points possible (number), null if not shown
- status: "not_submitted", "submitted", or "graded"
- detailUrl: the relative URL to the assignment detail page (contains "dropbox" or "folder" with db= or fid= parameter)
- assignmentId: numeric ID from the URL (db= or fid= parameter)

Respond with ONLY valid JSON:
{"assignments": [{"title": "...", "dueDate": null, "points": null, "status": "not_submitted", "detailUrl": "/d2l/...", "assignmentId": "12345"}]}`,

  assignment_detail: (text) => `You are extracting the FULL content of a university assignment from its Brightspace detail page.

PAGE TEXT:
${text}

Extract everything a student needs to complete this assignment:

1. fullInstructions: The COMPLETE assignment instructions. Preserve all details, requirements, sections, numbered lists.
2. rubric: If grading criteria or a rubric is visible, extract it showing categories, descriptions, and point values.
3. requirements: Concise bullet-point list of deliverables (e.g., "2000-word essay", "10-slide presentation", "5 peer-reviewed sources").
4. attachments: File names of any attachments mentioned (e.g., "template.docx", "rubric.pdf").
5. wordCount: Word/page count requirement if mentioned.
6. formatRequirements: Formatting requirements (APA, MLA, font, spacing, etc).

Respond with ONLY valid JSON:
{
  "fullInstructions": "Complete text...",
  "rubric": "Rubric text or null",
  "requirements": ["Req 1", "Req 2"],
  "attachments": ["file.docx"],
  "wordCount": "2000 words",
  "formatRequirements": "APA 7th edition"
}`,

  quizzes: (text, courseId) => `You are extracting quiz information from a Brightspace LMS quizzes page for course ${courseId}.

PAGE TEXT:
${text}

Extract ALL quizzes visible:
- title: quiz name
- dueDate: due/end date in ISO 8601 if visible, null otherwise
- timeLimit: time limit if shown (e.g., "60 minutes")
- attempts: allowed attempts if shown
- status: "not_attempted", "completed", or "in_progress"
- quizId: numeric ID from URL (qu= parameter)

Respond with ONLY valid JSON:
{"quizzes": [{"title": "...", "dueDate": null, "timeLimit": null, "attempts": null, "status": "not_attempted", "quizId": "789"}]}`,

  course_content: (text, courseId) => `You are extracting course content/module structure from a Brightspace content page for course ${courseId}.

PAGE TEXT:
${text}

Extract the module and topic structure:
- Each module has a name and contains topics
- Topics can be lectures, readings, files, links, or videos

Respond with ONLY valid JSON:
{"materials": [{"moduleName": "Week 1: Introduction", "topics": [{"title": "Lecture Slides", "type": "file"}, {"title": "Chapter 1", "type": "reading"}]}]}

If no content found, return {"materials": []}.`,
};

async function parsePageContent(pageText, pageType, courseId) {
  const promptFn = PAGE_PROMPTS[pageType];
  if (!promptFn) throw new Error(`Unknown page type: ${pageType}`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: promptFn(pageText, courseId),
      },
    ],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse structured data from Claude response');
  }

  return JSON.parse(jsonMatch[0]);
}

// ─── Written Content Generation ─────────────────────────────────────────────

const WRITTEN_PROMPTS = {
  essay: `Write a well-structured academic essay based on the assignment instructions below.
Include an introduction with a clear thesis, body paragraphs with evidence and analysis, and a conclusion.
Use formal academic tone. If citation style is specified, follow it.
The writing must sound like a real university student wrote it, not an AI. Vary sentence length. Have a voice. Be specific.`,

  reflection: `Write a thoughtful personal reflection based on the assignment instructions below.
Use first person throughout. Connect personal experiences to course concepts. Show critical thinking and self-awareness.
Be genuine and introspective, not generic. Write like you're actually reflecting, not performing reflection.
Acknowledge mixed feelings. Let some mess in. A real person doesn't have perfectly organized thoughts.`,

  notes: `Create comprehensive study notes based on the assignment/course content below.
Organize by topic with clear headings. Include key concepts, definitions, important details, and connections between ideas.
Make it scannable and useful for exam prep. Write like a student taking good notes, not a textbook.`,

  outline: `Create a detailed assignment outline based on the instructions below.
Include a thesis/main argument, organized sections with sub-points, evidence to include, and a conclusion plan.
This is a roadmap for writing the full assignment. Keep it practical and concrete, not generic filler.`,

  instructions: `Create a clear, step-by-step guide for completing a hands-on/technical assignment based on the instructions below.
This is for assignments that involve software like Excel, Access, Word, or other tools where the student needs to perform specific actions.
Break down every task into numbered steps a student can follow. Be specific about what to click, type, format, or modify.
Include the exact values, formulas, field names, or settings mentioned in the assignment.
If the assignment references a template or starter file, explain what to do with it step by step.
Write like a helpful lab partner walking someone through it, not a manual.`,
};

async function generateWrittenContent(assignmentText, outputType) {
  const systemPrompt = WRITTEN_PROMPTS[outputType] || WRITTEN_PROMPTS.essay;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${systemPrompt}
${HUMANIZER_RULES}
ASSIGNMENT INSTRUCTIONS:
${assignmentText}

Respond with ONLY valid JSON in this format:
{
  "title": "Title of the document",
  "outputType": "${outputType}",
  "sections": [
    {
      "heading": "Section Heading",
      "content": "Full paragraph text for this section. Use \\n for paragraph breaks within a section."
    }
  ],
  "references": ["Reference 1 in proper format", "Reference 2"]
}

Write substantively — each section should have real, detailed content appropriate for a university assignment.
Your writing MUST pass as human-written. No AI-sounding filler. Vary rhythm, be specific, have a voice.
If references aren't needed (like for reflections or notes), return an empty array.`,
      },
    ],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse written content from Claude');

  const content = JSON.parse(jsonMatch[0]);
  if (!content.title || !Array.isArray(content.sections)) {
    throw new Error('Invalid content structure');
  }

  return content;
}

module.exports = { generatePresentationContent, parsePageContent, generateWrittenContent };
