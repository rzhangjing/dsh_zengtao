/**
 * 禅道 REST **v2** 路由表 —— **自动生成，不要手改**。
 *
 * 生成方式：`node scripts/gen-rest-v2-routes.mjs`
 * 数据来源：官方 SDK `zentao-api@0.7.0`（随官方 `zentao-cli` 发布，MIT）的
 *          `dist/modules/generated.js`。官方 CLI 正是照这张表决定动作可用性
 *          （`ipd` 字段就是该动作要求的最低 IPD 版本，例如 `ipd5.5`）。
 *
 * 本文件只保留**判定所需**的字段（method/path/minVersion/resultGetter/pagerGetter/
 * pathParams/params 的名字与枚举值），描述与展示文案都已裁掉。
 * 这是**接口事实**（路径与方法），不是官方代码的拷贝。
 *
 * 纯数据模块：不 import 任何东西。
 */

/* eslint-disable */

export const REST_V2_MODULES = {
  "user": [
    {
      "name": "list",
      "method": "GET",
      "path": "/users",
      "ipd": "ipd5.0",
      "getter": "users",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "inside",
            "outside"
          ]
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "realname_asc",
            "realname_desc",
            "account_asc",
            "account_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/users",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/users/{userID}",
      "ipd": "ipd5.0",
      "getter": "user",
      "type": "get",
      "pathParams": [
        "userID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/users/{userID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "userID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/users/{userID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "userID"
      ]
    }
  ],
  "program": [
    {
      "name": "list",
      "method": "GET",
      "path": "/programs",
      "ipd": "ipd5.0",
      "getter": "programs",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "unclosed",
            "wait",
            "doing",
            "suspended",
            "delayed",
            "closed"
          ]
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/programs",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/programs/{programID}",
      "ipd": "ipd5.0",
      "getter": "program",
      "type": "get",
      "pathParams": [
        "programID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/programs/{programID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "programID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/programs/{programID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "programID"
      ]
    }
  ],
  "product": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products",
      "ipd": "ipd5.0",
      "getter": "products",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "noclosed",
            "closed"
          ]
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "programProducts",
      "method": "GET",
      "path": "/programs/{programID}/products",
      "ipd": "ipd5.5",
      "getter": "products",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "programID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "noclosed",
            "closed"
          ],
          "default": "noclosed"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/products",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "close",
      "method": "POST",
      "path": "/products/{productID}/close",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "createStoryModule",
      "method": "POST",
      "path": "/products/{productID}/story/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "createBugModule",
      "method": "POST",
      "path": "/products/{productID}/bug/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "createTestcaseModule",
      "method": "POST",
      "path": "/products/{productID}/testcase/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/products/{productID}",
      "ipd": "ipd5.0",
      "getter": "product",
      "type": "get",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/products/{productID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/products/{productID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "productID"
      ]
    }
  ],
  "project": [
    {
      "name": "list",
      "method": "GET",
      "path": "/projects",
      "ipd": "ipd5.0",
      "getter": "projects",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "undone",
            "wait",
            "doing"
          ],
          "default": "undone"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "programProjects",
      "method": "GET",
      "path": "/programs/{programID}/projects",
      "ipd": "ipd5.5",
      "getter": "projects",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "programID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "undone",
            "wait",
            "doing"
          ],
          "default": "undone"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "team",
      "method": "GET",
      "path": "/projects/team",
      "ipd": "ipd5.5",
      "getter": "members",
      "type": "list",
      "params": [
        {
          "name": "projectID",
          "required": true
        }
      ]
    },
    {
      "name": "projectMembers",
      "method": "GET",
      "path": "/projects/{projectID}/members",
      "ipd": "ipd5.5",
      "getter": "members",
      "type": "list",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/projects",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "close",
      "method": "POST",
      "path": "/projects/{projectID}/close",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "createStory",
      "method": "POST",
      "path": "/projects/{projectID}/stories",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "createBug",
      "method": "POST",
      "path": "/projects/{projectID}/bugs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "createTask",
      "method": "POST",
      "path": "/projects/{projectID}/tasks",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/projects/{projectID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/projects/{projectID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "members",
      "method": "PUT",
      "path": "/projects/{projectID}/members",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "projectID"
      ]
    }
  ],
  "execution": [
    {
      "name": "list",
      "method": "GET",
      "path": "/executions",
      "ipd": "ipd5.0",
      "getter": "executions",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "undone",
            "wait",
            "doing"
          ],
          "default": "undone"
        },
        {
          "name": "orderBy",
          "values": [
            "rawID_asc",
            "rawID_desc",
            "nameCol_asc",
            "nameCol_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "projectExecutions",
      "method": "GET",
      "path": "/projects/{projectID}/executions",
      "ipd": "ipd5.5",
      "getter": "executions",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "projectID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "undone",
            "wait",
            "doing"
          ],
          "default": "undone"
        },
        {
          "name": "orderBy",
          "values": [
            "rawID_asc",
            "rawID_desc",
            "nameCol_asc",
            "nameCol_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "team",
      "method": "GET",
      "path": "/executions/team",
      "ipd": "ipd5.5",
      "getter": "members",
      "type": "list",
      "params": [
        {
          "name": "executionID",
          "required": true
        }
      ]
    },
    {
      "name": "executionMembers",
      "method": "GET",
      "path": "/executions/{executionID}/members",
      "ipd": "ipd5.5",
      "getter": "members",
      "type": "list",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/executions",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "close",
      "method": "POST",
      "path": "/executions/{executionID}/close",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "createTaskModule",
      "method": "POST",
      "path": "/executions/{executionID}/task/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/executions/{executionID}",
      "ipd": "ipd5.0",
      "getter": "execution",
      "type": "get",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/executions/{executionID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/executions/{executionID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "members",
      "method": "PUT",
      "path": "/executions/{executionID}/members",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "executionID"
      ]
    }
  ],
  "productplan": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/productplans",
      "ipd": "ipd5.0",
      "getter": "productplans",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "undone",
            "wait",
            "doing"
          ],
          "default": "undone"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "begin_asc",
            "begin_desc",
            "end_asc",
            "end_desc",
            "status_asc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/productplans",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/productplans/{planID}",
      "ipd": "ipd5.0",
      "getter": "productplan",
      "type": "get",
      "pathParams": [
        "planID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/productplans/{planID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "planID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/productplans/{planID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "planID"
      ]
    }
  ],
  "story": [
    {
      "name": "list",
      "method": "GET",
      "path": "/{scope}/{scopeID}/stories",
      "ipd": "ipd5.0",
      "getter": "stories",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "scope",
        "scopeID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "allstory",
            "assignedtome",
            "openedbyme",
            "reviewbyme",
            "draftstory"
          ]
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "modules",
      "method": "GET",
      "path": "/products/{productID}/story/modules",
      "ipd": "ipd5.5",
      "getter": "tree",
      "type": "list",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/stories",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/stories/{storyID}",
      "ipd": "ipd5.0",
      "getter": "story",
      "type": "get",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/stories/{storyID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "updateModule",
      "method": "PUT",
      "path": "/story/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/stories/{storyID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "deleteModule",
      "method": "DELETE",
      "path": "/story/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/stories/{storyID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "change",
      "method": "PUT",
      "path": "/stories/{storyID}/change",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/stories/{storyID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    }
  ],
  "epic": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/epics",
      "ipd": "ipd5.0",
      "getter": "epics",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "allstory",
            "assignedtome",
            "openedbyme",
            "reviewbyme",
            "draftstory"
          ],
          "default": "unclosed"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/epics",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/epics/{storyID}",
      "ipd": "ipd5.0",
      "getter": "epic",
      "type": "get",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/epics/{storyID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/epics/{storyID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/epics/{storyID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "change",
      "method": "PUT",
      "path": "/epics/{storyID}/change",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/epics/{storyID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    }
  ],
  "requirement": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/requirements",
      "ipd": "ipd5.0",
      "getter": "requirements",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "allstory",
            "assignedtome",
            "openedbyme",
            "reviewbyme",
            "draftstory"
          ],
          "default": "unclosed"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/requirements",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/requirements/{storyID}",
      "ipd": "ipd5.0",
      "getter": "requirement",
      "type": "get",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/requirements/{storyID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/requirements/{storyID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/requirements/{storyID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "change",
      "method": "PUT",
      "path": "/requirements/{storyID}/change",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/requirements/{storyID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "storyID"
      ]
    }
  ],
  "bug": [
    {
      "name": "list",
      "method": "GET",
      "path": "/{scope}/{scopeID}/bugs",
      "ipd": "ipd5.0",
      "getter": "bugs",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "scope",
        "scopeID"
      ],
      "params": [
        {
          "name": "browseType"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "modules",
      "method": "GET",
      "path": "/products/{productID}/bug/modules",
      "ipd": "ipd5.5",
      "getter": "tree",
      "type": "list",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/bugs",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/bugs/{bugID}",
      "ipd": "ipd5.0",
      "getter": "bug",
      "type": "get",
      "pathParams": [
        "bugID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/bugs/{bugID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "bugID"
      ]
    },
    {
      "name": "updateModule",
      "method": "PUT",
      "path": "/bug/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/bugs/{bugID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "bugID"
      ]
    },
    {
      "name": "deleteModule",
      "method": "DELETE",
      "path": "/bug/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/bugs/{bugID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "bugID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/bugs/{bugID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "bugID"
      ]
    },
    {
      "name": "confirm",
      "method": "PUT",
      "path": "/bugs/{bugID}/confirm",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "bugID"
      ]
    },
    {
      "name": "resolve",
      "method": "PUT",
      "path": "/bugs/{bugID}/resolve",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "bugID"
      ]
    }
  ],
  "testcase": [
    {
      "name": "list",
      "method": "GET",
      "path": "/{scope}/{scopeID}/testcases",
      "ipd": "ipd5.0",
      "getter": "testcases",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "scope",
        "scopeID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "needconfirm"
          ],
          "default": "all"
        },
        {
          "name": "orderBy"
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "modules",
      "method": "GET",
      "path": "/products/{productID}/testcase/modules",
      "ipd": "ipd5.5",
      "getter": "tree",
      "type": "list",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/testcases",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/testcases/{caseID}",
      "ipd": "ipd5.0",
      "getter": "testcase",
      "type": "get",
      "pathParams": [
        "caseID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/testcases/{caseID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "caseID"
      ]
    },
    {
      "name": "updateModule",
      "method": "PUT",
      "path": "/testcase/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/testcases/{caseID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "caseID"
      ]
    },
    {
      "name": "deleteModule",
      "method": "DELETE",
      "path": "/testcase/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "moduleID"
      ]
    }
  ],
  "task": [
    {
      "name": "list",
      "method": "GET",
      "path": "/executions/{executionID}/tasks",
      "ipd": "ipd5.0",
      "getter": "tasks",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "executionID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "unclosed",
            "assignedtome",
            "myinvolved",
            "assignedbyme"
          ],
          "default": "unclosed"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "modules",
      "method": "GET",
      "path": "/executions/{executionID}/task/modules",
      "ipd": "ipd5.5",
      "getter": "tree",
      "type": "list",
      "pathParams": [
        "executionID"
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/tasks",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/tasks/{taskID}",
      "ipd": "ipd5.0",
      "getter": "task",
      "type": "get",
      "pathParams": [
        "taskID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/tasks/{taskID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "taskID"
      ]
    },
    {
      "name": "updateModule",
      "method": "PUT",
      "path": "/task/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/tasks/{taskID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "taskID"
      ]
    },
    {
      "name": "deleteModule",
      "method": "DELETE",
      "path": "/task/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/tasks/{taskID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "taskID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/tasks/{taskID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "taskID"
      ]
    },
    {
      "name": "finish",
      "method": "PUT",
      "path": "/tasks/{taskID}/finish",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "taskID"
      ]
    },
    {
      "name": "start",
      "method": "PUT",
      "path": "/tasks/{taskID}/start",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "taskID"
      ]
    }
  ],
  "issue": [
    {
      "name": "list",
      "method": "GET",
      "path": "/issues",
      "ipd": "ipd5.5",
      "getter": "issues",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "open",
            "assignto",
            "assignby",
            "closed",
            "resolved",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "severity_asc",
            "severity_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "projectIssues",
      "method": "GET",
      "path": "/projects/{projectID}/issues",
      "ipd": "ipd5.5",
      "getter": "issues",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "projectID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "open",
            "assignto",
            "assignby",
            "closed",
            "resolved",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "severity_asc",
            "severity_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "executionIssues",
      "method": "GET",
      "path": "/executions/{executionID}/issues",
      "ipd": "ipd5.5",
      "getter": "issues",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "executionID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "open",
            "assignto",
            "assignby",
            "closed",
            "resolved",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "severity_asc",
            "severity_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/issues",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/issues/{issueID}",
      "ipd": "ipd5.5",
      "getter": "issue",
      "type": "get",
      "pathParams": [
        "issueID"
      ]
    }
  ],
  "risk": [
    {
      "name": "list",
      "method": "GET",
      "path": "/risks",
      "ipd": "ipd5.5",
      "getter": "risks",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "active",
            "assignTo",
            "assignBy",
            "closed",
            "hangup",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc",
            "pri_asc",
            "pri_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "projectRisks",
      "method": "GET",
      "path": "/projects/{projectID}/risks",
      "ipd": "ipd5.5",
      "getter": "risks",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "projectID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "active",
            "assignTo",
            "assignBy",
            "closed",
            "hangup",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc",
            "pri_asc",
            "pri_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "executionRisks",
      "method": "GET",
      "path": "/executions/{executionID}/risks",
      "ipd": "ipd5.5",
      "getter": "risks",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "executionID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "active",
            "assignTo",
            "assignBy",
            "closed",
            "hangup",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc",
            "pri_asc",
            "pri_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/risks",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/risks/{riskID}",
      "ipd": "ipd5.5",
      "getter": "risk",
      "type": "get",
      "pathParams": [
        "riskID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/risks/{riskID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "riskID"
      ]
    }
  ],
  "meeting": [
    {
      "name": "list",
      "method": "GET",
      "path": "/meetings",
      "ipd": "ipd5.5",
      "getter": "meetings",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "booked",
            "participate"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "date_asc",
            "date_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "projectMeetings",
      "method": "GET",
      "path": "/projects/{projectID}/meetings",
      "ipd": "ipd5.5",
      "getter": "meetings",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "projectID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "booked",
            "participate"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "date_asc",
            "date_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "executionMeetings",
      "method": "GET",
      "path": "/executions/{executionID}/meetings",
      "ipd": "ipd5.5",
      "getter": "meetings",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "executionID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "booked",
            "participate"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "date_asc",
            "date_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/meetings",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/meetings/{meetingID}",
      "ipd": "ipd5.5",
      "getter": "meeting",
      "type": "get",
      "pathParams": [
        "meetingID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/meetings/{meetingID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "meetingID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/meetings/{meetingID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "meetingID"
      ]
    },
    {
      "name": "minutes",
      "method": "PUT",
      "path": "/meetings/{meetingID}/minutes",
      "ipd": "ipd5.5",
      "type": "action",
      "pathParams": [
        "meetingID"
      ]
    }
  ],
  "feedback": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/feedbacks",
      "ipd": "ipd5.0",
      "getter": "feedbacks",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "doing",
            "toclosed",
            "review",
            "assigntome",
            "openedbyme"
          ],
          "default": "wait"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/feedbacks",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "createBug",
      "method": "POST",
      "path": "/feedbacks/{feedbackID}/bugs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "createTicket",
      "method": "POST",
      "path": "/feedbacks/{feedbackID}/tickets",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "createTodo",
      "method": "POST",
      "path": "/feedbacks/{feedbackID}/todos",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "createStory",
      "method": "POST",
      "path": "/feedbacks/{feedbackID}/stories",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "createTask",
      "method": "POST",
      "path": "/feedbacks/{feedbackID}/tasks",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/feedbacks/{feedbackID}",
      "ipd": "ipd5.0",
      "getter": "feedback",
      "type": "get",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/feedbacks/{feedbackID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/feedbacks/{feedbackID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/feedbacks/{feedbackID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "feedbackID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/feedbacks/{feedbackID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "feedbackID"
      ]
    }
  ],
  "ticket": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/tickets",
      "ipd": "ipd5.0",
      "getter": "tickets",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "unclosed",
            "wait",
            "doing",
            "done",
            "finishedbyme",
            "assigntome",
            "openedbyme"
          ],
          "default": "wait"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/tickets",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "createStory",
      "method": "POST",
      "path": "/tickets/{ticketID}/stories",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "ticketID"
      ]
    },
    {
      "name": "createBug",
      "method": "POST",
      "path": "/tickets/{ticketID}/bugs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "ticketID"
      ]
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/tickets/{ticketID}",
      "ipd": "ipd5.0",
      "getter": "ticket",
      "type": "get",
      "pathParams": [
        "ticketID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/tickets/{ticketID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "ticketID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/tickets/{ticketID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "ticketID"
      ]
    },
    {
      "name": "activate",
      "method": "PUT",
      "path": "/tickets/{ticketID}/activate",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "ticketID"
      ]
    },
    {
      "name": "close",
      "method": "PUT",
      "path": "/tickets/{ticketID}/close",
      "ipd": "ipd5.0",
      "type": "action",
      "pathParams": [
        "ticketID"
      ]
    }
  ],
  "system": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/systems",
      "ipd": "ipd5.0",
      "getter": "systems",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/systems",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/systems/{systemID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "systemID"
      ]
    }
  ],
  "build": [
    {
      "name": "list",
      "method": "GET",
      "path": "/{scope}/{scopeID}/builds",
      "ipd": "ipd5.0",
      "getter": "builds",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "scope",
        "scopeID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "active",
            "closed"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "date_asc",
            "date_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/builds",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/builds/{buildID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "buildID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/builds/{buildID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "buildID"
      ]
    }
  ],
  "testtask": [
    {
      "name": "list",
      "method": "GET",
      "path": "/{scope}/{scopeID}/testtasks",
      "ipd": "ipd5.0",
      "getter": "testtasks",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "scope",
        "scopeID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "doing",
            "done",
            "blocked"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/testtasks",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/testtasks/{testtaskID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "testtaskID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/testtasks/{testtaskID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "testtaskID"
      ]
    }
  ],
  "release": [
    {
      "name": "list",
      "method": "GET",
      "path": "/products/{productID}/releases",
      "ipd": "ipd5.0",
      "getter": "releases",
      "pager": "pager",
      "type": "list",
      "pathParams": [
        "productID"
      ],
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "normal",
            "fail",
            "terminate"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "date_asc",
            "date_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/releases",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/releases/{releaseID}",
      "ipd": "ipd5.0",
      "type": "update",
      "pathParams": [
        "releaseID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/releases/{releaseID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "releaseID"
      ]
    }
  ],
  "file": [
    {
      "name": "create",
      "method": "POST",
      "path": "/files",
      "ipd": "ipd5.0",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/files/{fileID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "fileID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/files/{fileID}",
      "ipd": "ipd5.0",
      "type": "delete",
      "pathParams": [
        "fileID"
      ]
    }
  ],
  "workflow": [
    {
      "name": "list",
      "method": "GET",
      "path": "/workflow/contract",
      "ipd": "ipd5.5",
      "getter": "dataList",
      "pager": "pager",
      "type": "list"
    },
    {
      "name": "getContract",
      "method": "GET",
      "path": "/workflow/contract/1",
      "ipd": "ipd5.5",
      "getter": "data",
      "type": "get"
    },
    {
      "name": "create",
      "method": "POST",
      "path": "/workflow/contract",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/workflow/contract/{contractID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "contractID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/workflow/contract/{contractID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "contractID"
      ]
    }
  ],
  "doc": [
    {
      "name": "mySpaces",
      "method": "GET",
      "path": "/doc/my/spaces",
      "ipd": "ipd5.5",
      "getter": "spaces",
      "type": "list"
    },
    {
      "name": "teamSpaces",
      "method": "GET",
      "path": "/doc/team/spaces",
      "ipd": "ipd5.5",
      "getter": "spaces",
      "type": "list"
    },
    {
      "name": "productSpaces",
      "method": "GET",
      "path": "/doc/product/spaces",
      "ipd": "ipd5.5",
      "getter": "spaces",
      "type": "list"
    },
    {
      "name": "projectSpaces",
      "method": "GET",
      "path": "/doc/project/spaces",
      "ipd": "ipd5.5",
      "getter": "spaces",
      "type": "list"
    },
    {
      "name": "myLibs",
      "method": "GET",
      "path": "/doc/my/spaces/{spaceID}/libs",
      "ipd": "ipd5.5",
      "getter": "libs",
      "type": "list",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "teamLibs",
      "method": "GET",
      "path": "/doc/team/spaces/{spaceID}/libs",
      "ipd": "ipd5.5",
      "getter": "libs",
      "type": "list",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "productLibs",
      "method": "GET",
      "path": "/doc/product/spaces/{productID}/libs",
      "ipd": "ipd5.5",
      "getter": "libs",
      "type": "list",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "projectLibs",
      "method": "GET",
      "path": "/doc/project/spaces/{projectID}/libs",
      "ipd": "ipd5.5",
      "getter": "libs",
      "type": "list",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "myDocs",
      "method": "GET",
      "path": "/doc/my/spaces/{spaceID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "getter": "docs",
      "type": "list",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "teamDocs",
      "method": "GET",
      "path": "/doc/team/spaces/{spaceID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "getter": "docs",
      "type": "list",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "productDocs",
      "method": "GET",
      "path": "/doc/product/spaces/{productID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "getter": "docs",
      "type": "list",
      "pathParams": [
        "productID",
        "libID"
      ]
    },
    {
      "name": "projectDocs",
      "method": "GET",
      "path": "/doc/project/spaces/{projectID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "getter": "docs",
      "type": "list",
      "pathParams": [
        "projectID",
        "libID"
      ]
    },
    {
      "name": "myModules",
      "method": "GET",
      "path": "/doc/my/spaces/{spaceID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "getter": "modules",
      "type": "list",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "teamModules",
      "method": "GET",
      "path": "/doc/team/spaces/{spaceID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "getter": "modules",
      "type": "list",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "productModules",
      "method": "GET",
      "path": "/doc/product/spaces/{productID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "getter": "modules",
      "type": "list",
      "pathParams": [
        "productID",
        "libID"
      ]
    },
    {
      "name": "projectModules",
      "method": "GET",
      "path": "/doc/project/spaces/{projectID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "getter": "modules",
      "type": "list",
      "pathParams": [
        "projectID",
        "libID"
      ]
    },
    {
      "name": "createMySpace",
      "method": "POST",
      "path": "/doc/my/spaces",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "createTeamSpace",
      "method": "POST",
      "path": "/doc/team/spaces",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "createMyLib",
      "method": "POST",
      "path": "/doc/my/spaces/{spaceID}/libs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "createTeamLib",
      "method": "POST",
      "path": "/doc/team/spaces/{spaceID}/libs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "createProductLib",
      "method": "POST",
      "path": "/doc/product/spaces/{productID}/libs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "productID"
      ]
    },
    {
      "name": "createProjectLib",
      "method": "POST",
      "path": "/doc/project/spaces/{projectID}/libs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "projectID"
      ]
    },
    {
      "name": "createMyDoc",
      "method": "POST",
      "path": "/doc/my/spaces/{spaceID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "createTeamDoc",
      "method": "POST",
      "path": "/doc/team/spaces/{spaceID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "createProductDoc",
      "method": "POST",
      "path": "/doc/product/spaces/{productID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "productID",
        "libID"
      ]
    },
    {
      "name": "createProjectDoc",
      "method": "POST",
      "path": "/doc/project/spaces/{projectID}/libs/{libID}/docs",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "projectID",
        "libID"
      ]
    },
    {
      "name": "createMyModule",
      "method": "POST",
      "path": "/doc/my/spaces/{spaceID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "createTeamModule",
      "method": "POST",
      "path": "/doc/team/spaces/{spaceID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "spaceID",
        "libID"
      ]
    },
    {
      "name": "createProductModule",
      "method": "POST",
      "path": "/doc/product/spaces/{productID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "productID",
        "libID"
      ]
    },
    {
      "name": "createProjectModule",
      "method": "POST",
      "path": "/doc/project/spaces/{projectID}/libs/{libID}/modules",
      "ipd": "ipd5.5",
      "type": "create",
      "pathParams": [
        "projectID",
        "libID"
      ]
    },
    {
      "name": "getSpace",
      "method": "GET",
      "path": "/doc/spaces/{spaceID}",
      "ipd": "ipd5.5",
      "getter": "space",
      "type": "get",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "getLib",
      "method": "GET",
      "path": "/doc/libs/{libID}",
      "ipd": "ipd5.5",
      "getter": "lib",
      "type": "get",
      "pathParams": [
        "libID"
      ]
    },
    {
      "name": "get",
      "method": "GET",
      "path": "/doc/docs/{docID}",
      "ipd": "ipd5.5",
      "getter": "doc",
      "type": "get",
      "pathParams": [
        "docID"
      ]
    },
    {
      "name": "updateSpace",
      "method": "PUT",
      "path": "/doc/spaces/{spaceID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "updateLib",
      "method": "PUT",
      "path": "/doc/libs/{libID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "libID"
      ]
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/doc/docs/{docID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "docID"
      ]
    },
    {
      "name": "updateModule",
      "method": "PUT",
      "path": "/doc/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "moduleID"
      ]
    },
    {
      "name": "deleteSpace",
      "method": "DELETE",
      "path": "/doc/spaces/{spaceID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "spaceID"
      ]
    },
    {
      "name": "deleteLib",
      "method": "DELETE",
      "path": "/doc/libs/{libID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "libID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/doc/docs/{docID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "docID"
      ]
    },
    {
      "name": "deleteModule",
      "method": "DELETE",
      "path": "/doc/modules/{moduleID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "moduleID"
      ]
    }
  ],
  "todo": [
    {
      "name": "create",
      "method": "POST",
      "path": "/todos",
      "ipd": "ipd5.5",
      "type": "create"
    },
    {
      "name": "update",
      "method": "PUT",
      "path": "/todos/{todoID}",
      "ipd": "ipd5.5",
      "type": "update",
      "pathParams": [
        "todoID"
      ]
    },
    {
      "name": "delete",
      "method": "DELETE",
      "path": "/todos/{todoID}",
      "ipd": "ipd5.5",
      "type": "delete",
      "pathParams": [
        "todoID"
      ]
    }
  ],
  "my": [
    {
      "name": "todos",
      "method": "GET",
      "path": "/my/todos",
      "ipd": "ipd5.5",
      "getter": "todos",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "today",
            "future",
            "lag",
            "finished"
          ],
          "default": "all"
        },
        {
          "name": "orderBy"
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "tasks",
      "method": "GET",
      "path": "/my/tasks",
      "ipd": "ipd5.5",
      "getter": "tasks",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "unclosed",
            "assignedtome",
            "openedbyme",
            "finishedbyme",
            "closedbyme"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc",
            "pri_asc",
            "pri_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "bugs",
      "method": "GET",
      "path": "/my/bugs",
      "ipd": "ipd5.5",
      "getter": "bugs",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "unclosed",
            "assignedtome",
            "openedbyme",
            "resolvedbyme"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc",
            "severity_asc",
            "severity_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "stories",
      "method": "GET",
      "path": "/my/stories",
      "ipd": "ipd5.5",
      "getter": "stories",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "allstory",
            "assignedtome",
            "openedbyme",
            "reviewbyme",
            "draftstory"
          ],
          "default": "allstory"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "epics",
      "method": "GET",
      "path": "/my/epics",
      "ipd": "ipd5.5",
      "getter": "epics",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "allstory",
            "assignedtome",
            "openedbyme",
            "reviewbyme",
            "draftstory"
          ],
          "default": "allstory"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "requirements",
      "method": "GET",
      "path": "/my/requirements",
      "ipd": "ipd5.5",
      "getter": "requirements",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "allstory",
            "assignedtome",
            "openedbyme",
            "reviewbyme",
            "draftstory"
          ],
          "default": "allstory"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "testtasks",
      "method": "GET",
      "path": "/my/testtasks",
      "ipd": "ipd5.5",
      "getter": "testtasks",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "doing",
            "done"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "projects",
      "method": "GET",
      "path": "/my/projects",
      "ipd": "ipd5.5",
      "getter": "projects",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "undone",
            "wait",
            "doing"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "feedbacks",
      "method": "GET",
      "path": "/my/feedbacks",
      "ipd": "ipd5.5",
      "getter": "feedbacks",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "doing",
            "toclosed"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "tickets",
      "method": "GET",
      "path": "/my/tickets",
      "ipd": "ipd5.5",
      "getter": "tickets",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "unclosed",
            "wait",
            "doing",
            "done"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "testcases",
      "method": "GET",
      "path": "/my/testcases",
      "ipd": "ipd5.5",
      "getter": "testcases",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "wait",
            "doing",
            "pass",
            "fail"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    },
    {
      "name": "meetings",
      "method": "GET",
      "path": "/my/meetings",
      "ipd": "ipd5.5",
      "getter": "meetings",
      "pager": "pager",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "futureMeeting",
            "all",
            "booked",
            "participate"
          ],
          "default": "futureMeeting"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "date_asc",
            "date_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "issues",
      "method": "GET",
      "path": "/my/issues",
      "ipd": "ipd5.5",
      "getter": "issues",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "open",
            "assignto",
            "assignby",
            "closed",
            "resolved",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "title_asc",
            "title_desc",
            "severity_asc",
            "severity_desc",
            "status_asc",
            "status_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        }
      ]
    },
    {
      "name": "risks",
      "method": "GET",
      "path": "/my/risks",
      "ipd": "ipd5.5",
      "getter": "risks",
      "type": "list",
      "params": [
        {
          "name": "browseType",
          "values": [
            "all",
            "active",
            "assignTo",
            "assignBy",
            "closed",
            "hangup",
            "canceled"
          ],
          "default": "all"
        },
        {
          "name": "orderBy",
          "values": [
            "id_asc",
            "id_desc",
            "name_asc",
            "name_desc",
            "status_asc",
            "status_desc",
            "pri_asc",
            "pri_desc"
          ]
        },
        {
          "name": "recPerPage"
        },
        {
          "name": "pageID"
        },
        {
          "name": "filters"
        },
        {
          "name": "groupJoin",
          "values": [
            "and",
            "or"
          ]
        }
      ]
    }
  ]
}

/** 生成时的官方 SDK 版本（写进诊断，便于日后复现）。 */
export const REST_V2_SOURCE = Object.freeze({ package: 'zentao-api', version: "0.7.0" })

/** 取一个模块的动作表（模块不存在时返回空数组）。 */
export function v2Actions (moduleName) {
  return REST_V2_MODULES[moduleName] ?? []
}

/** 取一个动作定义（找不到返回 undefined）。 */
export function v2Action (moduleName, actionName) {
  return v2Actions(moduleName).find((action) => action.name === actionName)
}
