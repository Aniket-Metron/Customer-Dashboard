import { Request, Response } from 'express';
import pool from '../config/database';
import axios from 'axios';
import dotenv from 'dotenv';
import { filterByDateRange } from '../services/worklogService';
import { getAuthHeader } from '../utils/auth';

dotenv.config();

const formatIssue = (issue: any) => ({
    id: issue.id,
    key: issue.key,
    IntegrationName: issue.fields.summary,
    Assignee: issue.fields.assignee ? issue.fields.assignee.displayName : "null",
    Status: issue.fields.status.name,
    TeamLead: issue.fields.customfield_10147 ? issue.fields.customfield_10147.displayName : "null",
    QA: issue.fields.customfield_10146 ? issue.fields.customfield_10146.displayName : "null",
    Developer: issue.fields.customfield_10145 ? issue.fields.customfield_10145.displayName : "null",
    TimeEstimated: issue.fields.timeestimate ? issue.fields.timeestimate / 3600 : 0,
    Billable: issue.fields.customfield_10206 || "null",
    created: issue.fields.created
});

export const getHomeIntegrations = async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT project_key FROM reports');
        const projectKeys = result.rows.map(row => row.project_key);

        const auth = getAuthHeader();
        const queryStartDate = req.query.startDate as string;
        const queryEndDate = req.query.endDate as string;
        const currentDate = new Date();
        const defaultStartDate = new Date(currentDate);
        defaultStartDate.setFullYear(currentDate.getFullYear() - 1);
        const startDate = queryStartDate ? new Date(queryStartDate).getTime() : defaultStartDate.getTime();
        const endDate = queryEndDate ? new Date(queryEndDate).getTime() : currentDate.getTime();

        let epicIssues: any[] = [];
        for (const projectKey of projectKeys) {
            let startAt = 0;
            const maxResults = 100;
            let total: number;

            do {
                const response = await axios.post('https://metron-security.atlassian.net/rest/api/3/search', {
                    jql: `project = "${projectKey}" AND issuetype = Epic AND created >= "2024-01-01"`,
                    startAt,
                    maxResults
                }, {
                    headers: {
                        Authorization: auth
                    }
                });

                total = response.data.total;
                startAt += maxResults;

                const issues = response.data.issues.map((issue: any) => formatIssue(issue));
                epicIssues = [...epicIssues, ...issues];
            } while (startAt < total);
        }

        let epicIssuesProcessed = await Promise.all(epicIssues.map(async (epic: any) => {
            const epicWorklogResponse = await axios.get(`https://metron-security.atlassian.net/rest/api/3/issue/${epic.id}/worklog`, {
                headers: {
                    Authorization: auth
                }
            });

            const epicWorklogs = epicWorklogResponse.data.worklogs.map((worklog: any) => ({
                comment: worklog.comment,
                created: worklog.created,
                updated: worklog.updated,
                started: worklog.started,
                timeSpentSeconds: worklog.timeSpentSeconds,
                issueId: epic.id
            }));

            const filteredEpicWorklogs = filterByDateRange(epicWorklogs, startDate, endDate);
            const totalWorklogTime = filteredEpicWorklogs.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600;

            return {
                ...epic,
                totalWorklogTime
            };
        }));

        res.json(epicIssuesProcessed);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
};
