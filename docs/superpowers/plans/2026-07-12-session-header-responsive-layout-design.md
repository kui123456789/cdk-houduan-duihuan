# Session Header Responsive Layout Design

## Problem

The Session card shares a two-column desktop row with the account card. At intermediate desktop widths, its title/subtitle and action area require more horizontal space than the card provides. The heading cannot wrap, so the count badge overlaps the “获取 Session” button.

## Approved Design

Keep the existing compact two-column action grid when room is available. Make the Session heading wrap as a unit when space is constrained:

- Let the Session panel header shrink and wrap its subtitle normally.
- Give the header and action area flexible bases so the action area moves below the title instead of overflowing.
- Keep the count badge and action grid in separate grid columns, with the action column allowed to shrink safely.
- Preserve the existing button order, labels, and full-width upload action.

## Verification

- Add a structural CSS regression test for flexible wrapping and zero minimum widths.
- Run the focused test, complete test suite, production build, and `git diff --check`.
- Verify the live page at the reported desktop width and at a narrow viewport; ensure the badge and button rectangles do not intersect.
