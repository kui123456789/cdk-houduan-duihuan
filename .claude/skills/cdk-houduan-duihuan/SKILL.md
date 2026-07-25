```markdown
# cdk-houduan-duihuan Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns, coding conventions, and workflows for contributing to the `cdk-houduan-duihuan` repository. The project is a JavaScript codebase using React for the frontend and a custom Node.js backend. It emphasizes clear commit messages, modular code structure, and robust testing with Playwright. The documented workflows cover adding database tables, API endpoints, feature development, and security enhancements.

---

## Coding Conventions

**File Naming**
- Use `camelCase` for JavaScript files.
  - Example: `userRepository.js`, `authService.js`

**Import Style**
- Use relative imports.
  - Example:
    ```js
    import { getUserById } from '../repositories/userRepository';
    ```

**Export Style**
- Use named exports.
  - Example:
    ```js
    // userRepository.js
    export function getUserById(id) { ... }
    export function createUser(data) { ... }
    ```

**Commit Messages**
- Follow [Conventional Commits](https://www.conventionalcommits.org/) with these prefixes:
  - `fix`, `feat`, `refactor`, `chore`, `perf`
- Example:
  ```
  feat: add user role migration and repository
  ```

---

## Workflows

### Add Database Table or Model
**Trigger:** When introducing a new entity or table to the database  
**Command:** `/new-table`

1. **Create SQL migration files**  
   - Add `up` and `down` scripts in `server/db/migrations/`.
   - Example: `20230601_add_user_table.sql`
2. **Update or create repository file**  
   - Place in `server/repositories/`.
   - Example: `userRepository.js`
3. **Update or create model/service files as needed**  
   - Example: `userService.js`
4. **Update DB logic**  
   - Modify `server/db/index.js` if necessary.
5. **Add or update tests**  
   - Place in `test/`, e.g., `userRepository.test.mjs`.

---

### Add or Update API Endpoint
**Trigger:** When exposing new backend functionality or changing an API contract  
**Command:** `/new-endpoint`

1. **Create or update route file**  
   - In `server/routes/`, e.g., `userRoutes.js`.
2. **Update or create service logic**  
   - In `server/services/`, e.g., `userService.js`.
3. **Register the route**  
   - Update `server/app.js` or `server/index.js`.
4. **Update repository/model if needed**
5. **Add or update endpoint tests**  
   - In `test/`, e.g., `userApi.test.mjs`.

---

### Feature Development with Tests and Docs
**Trigger:** When adding a new feature or refactoring a major workflow  
**Command:** `/feature`

1. **Implement or refactor feature**  
   - In `src/` (frontend) or `server/` (backend).
2. **Update or create related test files**  
   - In `test/`, e.g., `featureX.test.mjs`.
3. **Update documentation**  
   - In `docs/` or `README.md`.
4. **Update configuration/environment files if needed**

---

### Security or Authentication Enhancement
**Trigger:** When adding or strengthening authentication, RBAC, or sensitive data handling  
**Command:** `/secure-auth`

1. **Add or update auth logic**  
   - In `server/auth/` or `server/services/`.
2. **Create or update migration files**  
   - For secrets/auth tables in `server/db/migrations/`.
3. **Update environment/config files**  
   - Example: `.env.example`
4. **Add or update authentication/authorization tests**  
   - In `test/`, e.g., `authService.test.mjs`.
5. **Update documentation as needed**

---

## Testing Patterns

- **Framework:** Playwright
- **Test File Pattern:** `*.spec.js` (or `*.test.mjs`)
- **Location:** All test files are under the `test/` directory.
- **Example:**
  ```js
  // test/userApi.test.mjs
  import { test, expect } from '@playwright/test';

  test('should create a new user', async ({ request }) => {
    const response = await request.post('/api/users', { data: { name: 'Alice' } });
    expect(response.ok()).toBeTruthy();
  });
  ```

---

## Commands

| Command         | Purpose                                                      |
|-----------------|--------------------------------------------------------------|
| /new-table      | Add a new database table/model with migrations and tests      |
| /new-endpoint   | Add or update a backend API endpoint with tests              |
| /feature        | Start a new feature or major refactor with tests and docs    |
| /secure-auth    | Enhance authentication, RBAC, or security with tests         |
```
