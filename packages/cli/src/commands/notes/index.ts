import { Command } from 'commander';
import { notesSeed } from './seed';
export const notes = new Command('notes')
  .description('Notes utilities')
  .addCommand(notesSeed);
