/** Real business scenarios shown on the open screen; picking one sends `question` as-is. */
export const SITUATIONS: { label: string; question: string }[] = [
  {
    label: 'Supplier meeting',
    question:
      'I meet Bosch India next week. Which of their parts are forecast to rise the most, and what should I push back on?',
  },
  {
    label: 'Leadership question',
    question:
      'My director thinks freight rates will spike and wants us to lock in prices. Does our forecast agree, and what is the news saying?',
  },
  {
    label: 'Alert decision',
    question: 'Two geopolitical alerts are still pending. What would each one cost us if confirmed?',
  },
  {
    label: 'Manager update',
    question: 'Give me the three biggest cost risks for this month that I can share with my manager, with numbers.',
  },
  {
    label: 'News check',
    question:
      'Aluminium and steel prices keep coming up in trade news. Is there anything current that could raise our costs, and how does it link back to our forecast?',
  },
  {
    label: 'Cost comparison',
    question: 'Compare our top 5 rising and falling parts this month so I can see them side by side.',
  },
];
