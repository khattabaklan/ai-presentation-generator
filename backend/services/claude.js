const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function generatePresentationContent(assignmentText, slideCount = 10, colorTheme = 'professional') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are an expert university presentation creator. Given the following assignment instructions, generate a structured presentation.

ASSIGNMENT INSTRUCTIONS:
${assignmentText}

REQUIREMENTS:
- Create exactly ${slideCount} slides
- Color theme preference: ${colorTheme}
- Include a title slide as slide 1
- Include a conclusion/summary slide as the last slide
- Each slide should have clear, concise bullet points (3-5 per slide)
- Generate detailed speaker notes for each slide (2-4 sentences per slide)

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

module.exports = { generatePresentationContent };
