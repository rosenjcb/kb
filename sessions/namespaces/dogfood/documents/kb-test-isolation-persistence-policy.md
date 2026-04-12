# Test Isolation and Persistence Policy

Created: 2026-04-12T13:55:58.286Z
Tags: testing, policy, persistence, dogfood

Documenting the agreed policy regarding test isolation and persistence:

- **CI/Functional Tests Isolation**: All tests that involve writing data should strictly write to namespace paths prefixed with `ci-` or `test-` to ensure they do not interfere with production data.

- **Persistence of Dogfood Documents**: Documents created for internal use (dogfood) are persistent and are tracked in the version control system (Git), ensuring they are maintained alongside the codebase.

- **Developer Checkpointing**: Developers are encouraged to routinely checkpoint their work sessions to GitHub. This practice helps in preventing data loss and allows for better tracking of changes and collaboration among team members.
