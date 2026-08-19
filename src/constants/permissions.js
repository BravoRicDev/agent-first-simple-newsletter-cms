export const PERMISSIONS = {
  superadmin: null,

  admin: {
    sites:    { create: false, read: true,  update: true,  delete: false },
    pages:    { create: true,  read: true,  update: true,  delete: true  },
    snippets: { create: true,  read: true,  update: true,  delete: true  },
    templates:{ create: true,  read: true,  update: true,  delete: true  },
    users:    { create: true,  read: true,  update: true,  delete: true  },
    settings: { create: false, read: true,  update: true,  delete: false },
    forms:    { create: true,  read: true,  update: true,  delete: true  },
    analytics:{ create: false, read: true,  update: false, delete: false },
    newsletter:{ create: true, read: true,  update: true,  delete: true  },
    audit:    { create: false, read: true,  update: false, delete: false },
  },

  collaboratore: {
    sites:    { create: false, read: false, update: false, delete: false },
    pages:    { create: true,  read: true,  update: true,  delete: true  },
    snippets: { create: true,  read: true,  update: true,  delete: true  },
    templates:{ create: true,  read: true,  update: true,  delete: true  },
    users:    { create: false, read: true,  update: false, delete: false },
    settings: { create: false, read: true,  update: false, delete: false },
    forms:    { create: true,  read: true,  update: true,  delete: true  },
    analytics:{ create: false, read: true,  update: false, delete: false },
    newsletter:{ create: false, read: true,  update: false, delete: false },
  },
};
