// Public interface of the posts feature (apps/web R4, R5). Everything else in this folder is internal.
//
// Route files (under routes/_authed/posts/, after requireSession and `requirePermission(..., 'posts:read')`)
//   PostsListPage, validatePostsSearch, pageOf, postsListQueryOptions   /posts?page=N
//   PostDetailPage, postQueryOptions                                    /posts/:postId
//   PostEditPage                                                        /posts/:postId/edit (also needs posts:write)
//
// App shell
//   PostsNav                       Header link, shown only with `posts:read`.
export { PostsNav } from './components/posts-nav'
export { postQueryOptions, postsListQueryOptions } from './hooks/use-posts'
export { pageOf, validatePostsSearch, type PostsSearch } from './lib/search'
export { PostDetailPage } from './pages/post-detail-page'
export { PostEditPage } from './pages/post-edit-page'
export { PostsListPage } from './pages/posts-list-page'
