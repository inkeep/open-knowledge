#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

__attribute__((noreturn)) static void fail(const char *step, long result, int error, int pid,
                                           int code) {
  char message[160];
  int length = snprintf(message, sizeof(message),
                        "cleanup-order rendezvous %s failed: result=%ld errno=%d pid=%d\n", step,
                        result, error, pid);
  if (length > 0) {
    size_t size = (size_t)length < sizeof(message) ? (size_t)length : sizeof(message) - 1;
    ssize_t written = write(STDERR_FILENO, message, size);
    (void)written;
  }
  _exit(code);
}

static void rendezvous(const char *phase, int pid) {
  const char *port = getenv("OK_PORT_OWNERSHIP_SCHEDULE_PORT");
  if (!port) return;
  int saved_errno = errno;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) fail("socket", fd, errno, pid, 90);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)atoi(port));
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    fail("connect", -1, errno, pid, 91);
  }
  char line[256];
  int length = snprintf(line, sizeof(line), "%s\t%d\n", phase, pid);
  ssize_t sent = write(fd, line, length);
  if (sent != length) fail("write", sent, sent < 0 ? errno : 0, pid, 92);
  char reply;
  ssize_t received = read(fd, &reply, 1);
  if (received != 1) fail("read", received, received < 0 ? errno : 0, pid, 93);
  close(fd);
  errno = saved_errno;
}

static void before_remove(const char *target) {
  const char *run_dir = getenv("OK_PORT_OWNERSHIP_SCHEDULE_RUN_DIR");
  if (!run_dir || strcmp(target, run_dir)) return;
  DIR *directory = opendir(target);
  if (!directory) return;
  int empty = 1;
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
      empty = 0;
      break;
    }
  }
  closedir(directory);
  if (empty) rendezvous("remove", getpid());
}
#ifdef __APPLE__
#define REPLACEMENT(name) observed_##name
#define ORIGINAL(name) name
#else
#define REPLACEMENT(name) name
#define ORIGINAL(name) original_##name
#endif
int REPLACEMENT(rmdir)(const char *target) {
#ifndef __APPLE__
  int (*original_rmdir)(const char *) = dlsym(RTLD_NEXT, "rmdir");
#endif
  before_remove(target);
  return ORIGINAL(rmdir)(target);
}
int REPLACEMENT(remove)(const char *target) {
#ifndef __APPLE__
  int (*original_remove)(const char *) = dlsym(RTLD_NEXT, "remove");
#endif
  before_remove(target);
  return ORIGINAL(remove)(target);
}
int REPLACEMENT(unlinkat)(int dirfd, const char *target, int flags) {
#ifndef __APPLE__
  int (*original_unlinkat)(int, const char *, int) = dlsym(RTLD_NEXT, "unlinkat");
#endif
  char resolved[4096];
  int resolved_fd = 0;
#ifdef __APPLE__
  resolved_fd = fcntl(dirfd, F_GETPATH, resolved) == 0;
#else
  char descriptor[64];
  snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", dirfd);
  ssize_t length = readlink(descriptor, resolved, sizeof(resolved) - 1);
  if (length >= 0) {
    resolved[length] = '\0';
    resolved_fd = 1;
  }
#endif
  if (target[0] == '/') {
    before_remove(target);
  } else if (resolved_fd) {
    size_t length = strlen(resolved);
    snprintf(resolved + length, sizeof(resolved) - length, "/%s", target);
    before_remove(resolved);
  }
  return ORIGINAL(unlinkat)(dirfd, target, flags);
}
#ifdef __APPLE__
#define INTERPOSE(replacement, original) \
  __attribute__((used)) static struct { const void *new_function; const void *old_function; } \
  interpose_##original __attribute__((section("__DATA,__interpose"))) = \
  { (const void *)(unsigned long)&replacement, (const void *)(unsigned long)&original };
INTERPOSE(observed_rmdir, rmdir)
INTERPOSE(observed_remove, remove)
INTERPOSE(observed_unlinkat, unlinkat)
#endif
