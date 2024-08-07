interface Worklog {
    comment: string;
    created: string;
    updated: string;
    started: string;
    timeSpentSeconds: number;
    issueId: string;
  }
  
  interface Subtask {
    id: string;
    key: string;
    IntegrationName: string;
    Status: string;
    worklogs: Worklog[];
    totalWorklogTime: number;
  }
  
  interface Issue {
    id: string;
    key: string;
    IntegrationName: string;
    Assignee?: string;
    Status: string;
    TeamLead?: string;
    QA?: string;
    Developer?: string;
    TimeEstimated: number;
    Billable: string;
    worklogs: Worklog[];
    subtasks?: Subtask[];
    totalWorklogTime: number;
  }
  
  interface EpicIssue extends Issue {
    childIssues: Issue[];
    created: string;
    startDate: string;
    endDate: string;
  }
  
  export const filterByDateRange = (worklogs: Worklog[], startDate: number, endDate: number): Worklog[] => {
    return worklogs.filter(worklog => {
      const worklogDate = new Date(worklog.started).getTime();
      return worklogDate >= startDate && worklogDate <= endDate;
    });
  };
  
  export const processWorklogs = (issues: Issue[], startDate: number, endDate: number): Issue[] => {
    return issues.map(issue => {
      const filteredWorklogs = filterByDateRange(issue.worklogs, startDate, endDate);
      const filteredSubtasks = issue.subtasks?.map(subtask => ({
        ...subtask,
        worklogs: filterByDateRange(subtask.worklogs, startDate, endDate),
        totalWorklogTime: filterByDateRange(subtask.worklogs, startDate, endDate).reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600,
      }));
  
      const totalWorklogTime = filteredWorklogs.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0) / 3600 +
        (filteredSubtasks ? filteredSubtasks.reduce((acc, subtask) => acc + subtask.totalWorklogTime, 0) : 0);
  
      return {
        ...issue,
        worklogs: filteredWorklogs,
        subtasks: filteredSubtasks,
        totalWorklogTime
      };
    });
  };
  