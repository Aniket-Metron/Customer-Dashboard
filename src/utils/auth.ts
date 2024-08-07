import dotenv from 'dotenv';
import { Buffer } from 'buffer';

dotenv.config();

export const getAuthHeader = () => {
  const jiraUser = process.env.JIRA_USER;
  const jiraPassword = process.env.JIRA_PASSWORD;
  const auth = Buffer.from(`${jiraUser}:${jiraPassword}`).toString('base64');
  return `Basic ${auth}`;
};
